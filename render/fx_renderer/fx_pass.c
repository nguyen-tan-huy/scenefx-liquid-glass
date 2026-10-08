#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <pixman.h>
#include <time.h>
#include <unistd.h>
#include <wlr/render/allocator.h>
#include <wlr/render/drm_syncobj.h>
#include <wlr/util/transform.h>
#include <wlr/util/log.h>
#include <wlr/util/region.h>

#include "render/egl.h"
#include "render/fx_renderer/fx_renderer.h"
#include "render/fx_renderer/shaders.h"
#include "render/pass.h"
#include "render/tracy.h"
#include "scenefx/render/fx_renderer/fx_offscreen_buffers.h"
#include "scenefx/render/fx_renderer/fx_renderer.h"
#include "scenefx/types/fx/blur_data.h"
#include "util/matrix.h"

#define MAX_QUADS 86 // 4kb

struct fx_render_texture_options fx_render_texture_options_default(
		const struct wlr_render_texture_options *base) {
	struct fx_render_texture_options options = {
		.corners = {0},
		.discard_transparent = false,
		.clip_box = NULL,
		.clipped_region = {0},
	};
	memcpy(&options.base, base, sizeof(*base));
	return options;
}

struct fx_render_rect_options fx_render_rect_options_default(
		const struct wlr_render_rect_options *base) {
	struct fx_render_rect_options options = {
		.base = *base,
		.clipped_region = {
			.area = { .0, .0, .0, .0 },
			.corners = {0},
		},
	};
	return options;
}

bool fx_render_pass_init_offscreen_buffers(struct wlr_render_pass *render_pass,
		struct wlr_output *output) {
	struct fx_gles_render_pass *pass = fx_get_render_pass(render_pass);
	if (output == NULL) {
		pass->fx_offscreen_buffers = NULL;
		return false;
	}
	if (pass->fx_offscreen_buffers != NULL) {
		wlr_log(WLR_ERROR, "Extra buffers called twice. Ignoring...");
		return true;
	}

	// For per output framebuffers
	pass->fx_offscreen_buffers = fx_offscreen_buffers_try_get(output);
	if (pass->fx_offscreen_buffers == NULL) {
		wlr_log(WLR_ERROR, "Failed to get/create effect framebuffers for output: %s",
				output->name);
		return false;
	}

	// Update the buffers if needed
	struct fx_renderer *renderer = pass->buffer->renderer;
	const int width = pass->buffer->buffer->width;
	const int height = pass->buffer->buffer->height;
	bool failed = false;
	fx_framebuffer_get_or_create_custom(renderer, output->allocator, width, height, false,
			&pass->fx_offscreen_buffers->blur_saved_pixels_buffer, &failed);
	fx_framebuffer_get_or_create_custom(renderer, output->allocator, width, height, true,
			&pass->fx_offscreen_buffers->effects_buffer, &failed);
	fx_framebuffer_get_or_create_custom(renderer, output->allocator, width, height, true,
			&pass->fx_offscreen_buffers->effects_buffer_swapped, &failed);
	fx_framebuffer_get_or_create_custom(renderer, output->allocator, width, height, false,
			&pass->fx_offscreen_buffers->optimized_blur_buffer, &failed);
	fx_framebuffer_get_or_create_custom(renderer, output->allocator, width, height, false,
			&pass->fx_offscreen_buffers->optimized_no_blur_buffer, &failed);

	// Bind back to the default buffer
	fx_framebuffer_bind(pass->buffer);

	if (failed) {
		fx_offscreen_buffers_destroy(pass->fx_offscreen_buffers);
		pass->fx_offscreen_buffers = NULL;
		wlr_log(WLR_ERROR, "Failed to create effect framebuffers");
		return false;
	}
	return true;
}

bool fx_render_pass_glass_cache_prepare(struct fx_gles_render_pass *pass,
		struct wlr_output *output, struct fx_glass_cache_entry *entry) {
	struct fx_renderer *renderer = pass->buffer->renderer;
	const int width = pass->buffer->buffer->width;
	const int height = pass->buffer->buffer->height;
	struct fx_framebuffer *before = entry->fb;
	bool same = before != NULL && before->buffer != NULL
		&& before->buffer->width == width && before->buffer->height == height;
	bool failed = false;
	fx_framebuffer_get_or_create_custom(renderer, output->allocator, width, height, true,
			&entry->fb, &failed);
	fx_framebuffer_bind(pass->buffer);
	if (failed || entry->fb == NULL) {
		entry->fb = NULL;
		entry->valid = false;
		return false;
	}
	if (!same) {
		entry->valid = false;
	}
	return true;
}

void fx_glass_cache_entry_release(struct fx_glass_cache_entry *entry) {
	if (entry->fb != NULL) {
		if (entry->fb->buffer != NULL) {
			wlr_buffer_drop(entry->fb->buffer);
		} else {
			fx_framebuffer_destroy(entry->fb);
		}
		entry->fb = NULL;
	}
	entry->output = NULL;
	entry->valid = false;
	pixman_region32_clear(&entry->dirty);
	pixman_region32_clear(&entry->refresh);
}

///
/// Base Wlroots pass functions
///

static const struct wlr_render_pass_impl render_pass_impl;

struct fx_gles_render_pass *fx_get_render_pass(struct wlr_render_pass *render_pass) {
	assert(render_pass->impl == &render_pass_impl);
	struct fx_gles_render_pass *pass = wl_container_of(render_pass, pass, base);
	return pass;
}

static bool render_pass_submit(struct wlr_render_pass *wlr_pass) {
	struct fx_gles_render_pass *pass = fx_get_render_pass(wlr_pass);
	struct fx_renderer *renderer = pass->buffer->renderer;
	struct fx_render_timer *timer = pass->timer;
	bool ok = false;

	TRACY_BOTH_ZONES_START(pass->buffer->renderer);
	push_fx_debug(renderer);

	if (timer) {
		// clear disjoint flag
		GLint64 disjoint;
		renderer->procs.glGetInteger64vEXT(GL_GPU_DISJOINT_EXT, &disjoint);
		// set up the query
		renderer->procs.glQueryCounterEXT(timer->id, GL_TIMESTAMP_EXT);
		// get end-of-CPU-work time in GL time domain
		renderer->procs.glGetInteger64vEXT(GL_TIMESTAMP_EXT, &timer->gl_cpu_end);
		// get end-of-CPU-work time in CPU time domain
		clock_gettime(CLOCK_MONOTONIC, &timer->cpu_end);
	}

	if (pass->signal_timeline != NULL) {
		EGLSyncKHR sync = wlr_egl_create_sync(renderer->egl, -1);
		if (sync == EGL_NO_SYNC_KHR) {
			goto out;
		}

		int sync_file_fd = wlr_egl_dup_fence_fd(renderer->egl, sync);
		wlr_egl_destroy_sync(renderer->egl, sync);
		if (sync_file_fd < 0) {
			goto out;
		}

		ok = wlr_drm_syncobj_timeline_import_sync_file(pass->signal_timeline, pass->signal_point, sync_file_fd);
		close(sync_file_fd);
		if (!ok) {
			goto out;
		}
	} else {
		glFlush();
	}

	ok = true;

out:
	glBindFramebuffer(GL_FRAMEBUFFER, 0);

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
	TRACY_GPU_ZONE_COLLECT(renderer);

	wlr_egl_restore_context(&pass->prev_ctx);

	wlr_drm_syncobj_timeline_unref(pass->signal_timeline);
	wlr_buffer_unlock(pass->buffer->buffer);

	pass->fx_offscreen_buffers = NULL;
	pixman_region32_fini(&pass->blur_padding_region);

	free(pass);

	return ok;
}

static void render_pass_add_texture(struct wlr_render_pass *wlr_pass,
		const struct wlr_render_texture_options *options) {
	struct fx_gles_render_pass *pass = fx_get_render_pass(wlr_pass);
	const struct fx_render_texture_options fx_options =
		fx_render_texture_options_default(options);
	// Re-use fx function but with default options
	// TODO: Simplified version?
	fx_render_pass_add_texture(pass, &fx_options);
}

static void render_pass_add_rect(struct wlr_render_pass *wlr_pass,
		const struct wlr_render_rect_options *options) {
	struct fx_gles_render_pass *pass = fx_get_render_pass(wlr_pass);
	const struct fx_render_rect_options fx_options =
		fx_render_rect_options_default(options);
	// Re-use fx function but with default options
	// TODO: Simplified version?
	fx_render_pass_add_rect(pass, &fx_options);
}

static const struct wlr_render_pass_impl render_pass_impl = {
	.submit = render_pass_submit,
	.add_texture = render_pass_add_texture,
	.add_rect = render_pass_add_rect,
};

///
/// FX pass functions
///

// TODO: REMOVE STENCILING

// Initialize the stenciling work
static void stencil_mask_init(void) {
	glClearStencil(0);
	glClear(GL_STENCIL_BUFFER_BIT);
	glEnable(GL_STENCIL_TEST);

	glStencilFunc(GL_ALWAYS, 1, 0xFF);
	glStencilOp(GL_KEEP, GL_KEEP, GL_REPLACE);
	// Disable writing to color buffer
	glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
}

// Close the mask
static void stencil_mask_close(bool draw_inside_mask) {
	// Reenable writing to color buffer
	glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
	if (draw_inside_mask) {
		glStencilFunc(GL_EQUAL, 1, 0xFF);
		glStencilOp(GL_KEEP, GL_KEEP, GL_REPLACE);
		return;
	}
	glStencilFunc(GL_NOTEQUAL, 1, 0xFF);
	glStencilOp(GL_KEEP, GL_KEEP, GL_KEEP);
}

// Finish stenciling and clear the buffer
static void stencil_mask_fini(void) {
	glClearStencil(0);
	glClear(GL_STENCIL_BUFFER_BIT);
	glDisable(GL_STENCIL_TEST);
}

static void render(const struct wlr_box *box, const pixman_region32_t *clip, GLint attrib) {
	pixman_region32_t region;
	pixman_region32_init_rect(&region, box->x, box->y, box->width, box->height);

	if (clip) {
		pixman_region32_intersect(&region, &region, clip);
	}

	int rects_len;
	const pixman_box32_t *rects = pixman_region32_rectangles(&region, &rects_len);
	if (rects_len == 0) {
		pixman_region32_fini(&region);
		return;
	}

	glEnableVertexAttribArray(attrib);

	for (int i = 0; i < rects_len;) {
		int batch = rects_len - i < MAX_QUADS ? rects_len - i : MAX_QUADS;
		int batch_end = batch + i;

		size_t vert_index = 0;
		GLfloat verts[MAX_QUADS * 6 * 2];
		for (; i < batch_end; i++) {
			const pixman_box32_t *rect = &rects[i];

			verts[vert_index++] = (GLfloat)(rect->x1 - box->x) / box->width;
			verts[vert_index++] = (GLfloat)(rect->y1 - box->y) / box->height;
			verts[vert_index++] = (GLfloat)(rect->x2 - box->x) / box->width;
			verts[vert_index++] = (GLfloat)(rect->y1 - box->y) / box->height;
			verts[vert_index++] = (GLfloat)(rect->x1 - box->x) / box->width;
			verts[vert_index++] = (GLfloat)(rect->y2 - box->y) / box->height;
			verts[vert_index++] = (GLfloat)(rect->x2 - box->x) / box->width;
			verts[vert_index++] = (GLfloat)(rect->y1 - box->y) / box->height;
			verts[vert_index++] = (GLfloat)(rect->x2 - box->x) / box->width;
			verts[vert_index++] = (GLfloat)(rect->y2 - box->y) / box->height;
			verts[vert_index++] = (GLfloat)(rect->x1 - box->x) / box->width;
			verts[vert_index++] = (GLfloat)(rect->y2 - box->y) / box->height;
		}

		glVertexAttribPointer(attrib, 2, GL_FLOAT, GL_FALSE, 0, verts);
		glDrawArrays(GL_TRIANGLES, 0, batch * 6);
	}

	glDisableVertexAttribArray(attrib);

	pixman_region32_fini(&region);
}

static void set_proj_matrix(GLint loc, float proj[9], const struct wlr_box *box) {
	float gl_matrix[9];
	wlr_matrix_identity(gl_matrix);
	wlr_matrix_translate(gl_matrix, box->x, box->y);
	wlr_matrix_scale(gl_matrix, box->width, box->height);
	wlr_matrix_multiply(gl_matrix, proj, gl_matrix);
	glUniformMatrix3fv(loc, 1, GL_FALSE, gl_matrix);
}

static void set_tex_matrix(GLint loc, enum wl_output_transform trans,
		const struct wlr_fbox *box) {
	float tex_matrix[9];
	wlr_matrix_identity(tex_matrix);
	wlr_matrix_translate(tex_matrix, box->x, box->y);
	wlr_matrix_scale(tex_matrix, box->width, box->height);
	wlr_matrix_translate(tex_matrix, .5, .5);

	// since textures have a different origin point we have to transform
	// differently if we are rotating
	if (trans & WL_OUTPUT_TRANSFORM_90) {
		wlr_matrix_transform(tex_matrix, wlr_output_transform_invert(trans));
	} else {
		wlr_matrix_transform(tex_matrix, trans);
	}
	wlr_matrix_translate(tex_matrix, -.5, -.5);

	glUniformMatrix3fv(loc, 1, GL_FALSE, tex_matrix);
}

static void setup_blending(enum wlr_render_blend_mode mode) {
	switch (mode) {
	case WLR_RENDER_BLEND_MODE_PREMULTIPLIED:
		glEnable(GL_BLEND);
		break;
	case WLR_RENDER_BLEND_MODE_NONE:
		glDisable(GL_BLEND);
		break;
	}
}

static bool apply_clip_region(pixman_region32_t *clip_region,
		const struct wlr_box *clipped_region_box, const struct fx_corner_fradii *corners) {
	if (!wlr_box_empty(clipped_region_box)) {
		float top = fmax(corners->top_left, corners->top_right);
		float bottom = fmax(corners->bottom_left, corners->bottom_right);
		float left = fmax(corners->top_left, corners->bottom_left);
		float right = fmax(corners->top_right, corners->bottom_right);

		pixman_region32_t user_clip_region;
		pixman_region32_init_rect(
			&user_clip_region,
			clipped_region_box->x + (left * 0.3),
			clipped_region_box->y + (top * 0.3),
			fmax(clipped_region_box->width - (left + right) * 0.3, 0),
			fmax(clipped_region_box->height - (top + bottom) * 0.3, 0)
		);
		pixman_region32_subtract(clip_region, clip_region, &user_clip_region);
		pixman_region32_fini(&user_clip_region);
		return true;
	}

	return false;
}

void fx_render_pass_add_texture(struct fx_gles_render_pass *pass,
		const struct fx_render_texture_options *fx_options) {
	const struct wlr_render_texture_options *options = &fx_options->base;
	struct fx_renderer *renderer = pass->buffer->renderer;
	struct fx_texture *texture = fx_get_texture(options->texture);

	struct tex_shader *shader = NULL;

	bool use_effects = !fx_corner_fradii_is_empty(&fx_options->corners)
		|| clipped_fregion_is_valid(&fx_options->clipped_region);
	switch (texture->target) {
	case GL_TEXTURE_2D:
		if (texture->has_alpha) {
			shader = use_effects
				? &renderer->shaders.tex_effects_rgba
				: &renderer->shaders.tex_rgba;
		} else {
			shader = use_effects
				? &renderer->shaders.tex_effects_rgbx
				: &renderer->shaders.tex_rgbx;
		}
		break;
	case GL_TEXTURE_EXTERNAL_OES:
		// EGL_EXT_image_dma_buf_import_modifiers requires
		// GL_OES_EGL_image_external
		assert(renderer->exts.OES_egl_image_external);
		shader = use_effects
			? &renderer->shaders.tex_effects_ext
			: &renderer->shaders.tex_ext;
		break;
	default:
		abort();
	}

	struct wlr_box dst_box;
	struct wlr_fbox src_fbox;
	wlr_render_texture_options_get_src_box(options, &src_fbox);
	wlr_render_texture_options_get_dst_box(options, &dst_box);
	float alpha = wlr_render_texture_options_get_alpha(options);

	const struct wlr_box *clip_box = &dst_box;
	if (!wlr_box_empty(fx_options->clip_box)) {
		clip_box = fx_options->clip_box;
	}

	src_fbox.x /= options->texture->width;
	src_fbox.y /= options->texture->height;
	src_fbox.width /= options->texture->width;
	src_fbox.height /= options->texture->height;

	TRACY_BOTH_ZONES_START(renderer);
	TRACY_ZONE_TEXT_f("dst_box (WxH, X, Y): %dx%d, %d, %d",
			dst_box.width, dst_box.height, dst_box.x, dst_box.y);
	TRACY_ZONE_TEXT_f("clip_box (WxH, X, Y): %dx%d, %d, %d",
			clip_box->width, clip_box->height, clip_box->x, clip_box->y);
	TRACY_ZONE_TEXT_f("src_box (WxH, X, Y): %lfx%lf, %lf, %lf",
			src_fbox.width, src_fbox.height, src_fbox.x, src_fbox.y);
	TRACY_ZONE_TEXT_f("Shader Type: %s",
			use_effects ? (
			 shader == &renderer->shaders.tex_effects_rgba ? "Effects RGBA"
			 : shader == &renderer->shaders.tex_effects_rgbx ? "Effects RGBX"
			 : "Effects EXT"
			) : (
				shader == &renderer->shaders.tex_rgba ? "RGBA"
				: shader == &renderer->shaders.tex_rgbx ? "RGBX"
				: "EXT"
			)
		);
	push_fx_debug(renderer);

	if (options->wait_timeline != NULL) {
		int sync_file_fd =
			wlr_drm_syncobj_timeline_export_sync_file(options->wait_timeline, options->wait_point);
		if (sync_file_fd < 0) {
			TRACY_BOTH_ZONES_END_FAIL;
			return;
		}

		EGLSyncKHR sync = wlr_egl_create_sync(renderer->egl, sync_file_fd);
		close(sync_file_fd);
		if (sync == EGL_NO_SYNC_KHR) {
			TRACY_BOTH_ZONES_END_FAIL;
			return;
		}

		bool ok = wlr_egl_wait_sync(renderer->egl, sync);
		wlr_egl_destroy_sync(renderer->egl, sync);
		if (!ok) {
			TRACY_BOTH_ZONES_END_FAIL;
			return;
		}
	}

	bool has_alpha = texture->has_alpha || alpha < 1.0 || use_effects;
	TRACY_ZONE_TEXT_f("Has Alpha: %d", has_alpha);
	setup_blending(!has_alpha ? WLR_RENDER_BLEND_MODE_NONE : options->blend_mode);

	pixman_region32_t clip_region;
	if (options->clip) {
		pixman_region32_init(&clip_region);
		pixman_region32_copy(&clip_region, options->clip);
	} else {
		pixman_region32_init_rect(&clip_region, dst_box.x, dst_box.y, dst_box.width, dst_box.height);
	}
	const struct wlr_box clipped_region_box = fx_options->clipped_region.area;
	struct fx_corner_fradii clipped_region_corners = fx_options->clipped_region.corners;
	apply_clip_region(&clip_region, &clipped_region_box, &clipped_region_corners);

	glUseProgram(shader->program);

	glActiveTexture(GL_TEXTURE0);
	glBindTexture(texture->target, texture->tex);

	switch (options->filter_mode) {
	case WLR_SCALE_FILTER_BILINEAR:
		glTexParameteri(texture->target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(texture->target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		break;
	case WLR_SCALE_FILTER_NEAREST:
		glTexParameteri(texture->target, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
		glTexParameteri(texture->target, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
		break;
	}

	glUniform1i(shader->tex, 0);
	glUniform1f(shader->alpha, alpha);

	glUniform1f(shader->discard_transparent, fx_options->discard_transparent);

	// swayctl: key ink over glass (fx_render_texture_options.ink_cache).
	// The uniform keeps its value per program: always set it.
	struct wlr_texture *ink_tex = NULL;
	struct fx_glass_cache_entry *ink = fx_options->ink_cache;
	struct fx_framebuffer *ink_fb = NULL;
	float ink_reach = fx_options->ink_reach > 0 ? fx_options->ink_reach : 48.0f;
	if (ink != NULL && ink->valid) {
		ink_fb = ink->fb;
	} else if (fx_options->ink && pass->ink_backdrop != NULL
			&& wlr_box_equal(&pass->ink_box, &fx_options->base.dst_box)) {
		// blurred glass: the blurred backdrop its pane was just drawn from.
		// It is only fresh around what this frame redraws (plus the blur's
		// padding): read close around the pixel, never out to the full reach
		ink_fb = pass->ink_backdrop;
		ink_reach = fminf(ink_reach, 16.0f);
	}
	if (shader->ink >= 0 && fx_options->ink && ink_fb != NULL && ink_fb->buffer != NULL) {
		ink_tex = fx_texture_from_buffer(&renderer->wlr_renderer, ink_fb->buffer);
		// making it binds (and unbinds) on unit 0, where the surface's own
		// texture already is: put that back
		glActiveTexture(GL_TEXTURE0);
		glBindTexture(texture->target, texture->tex);
	}
	glUniform1i(shader->ink, fx_options->ink && shader->ink >= 0);
	if (fx_options->ink && ink_tex == NULL) {
		glUniform2f(shader->ink_size, 0.0f, 0.0f); // nothing to read: light ink
	}
	if (ink_tex != NULL) {
		struct fx_texture *bt = fx_get_texture(ink_tex);
		glActiveTexture(GL_TEXTURE3);
		glBindTexture(bt->target, bt->tex);
		glTexParameteri(bt->target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(bt->target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		glActiveTexture(GL_TEXTURE0);
		glUniform1i(shader->ink_backdrop, 3);
		glUniform2f(shader->ink_size, ink_tex->width, ink_tex->height);
		glUniform1f(shader->ink_reach, ink_reach);
	}

	if (use_effects) {
		struct fx_corner_fradii corners = fx_options->corners;

		glUniform2f(shader->effects.size, clip_box->width, clip_box->height);
		glUniform2f(shader->effects.position, clip_box->x, clip_box->y);
		uniform_corner_radii_set(&shader->effects.radius, &corners);

		glUniform2f(shader->effects.clip_size, clipped_region_box.width, clipped_region_box.height);
		glUniform2f(shader->effects.clip_position, clipped_region_box.x, clipped_region_box.y);
		uniform_corner_radii_set(&shader->effects.clip_radius, &clipped_region_corners);
	}

	set_proj_matrix(shader->proj, pass->projection_matrix, &dst_box);
	set_tex_matrix(shader->tex_proj, options->transform, &src_fbox);

	render(&dst_box, &clip_region, shader->pos_attrib);
	pixman_region32_fini(&clip_region);

	glBindTexture(texture->target, 0);
	if (ink_tex != NULL) {
		glActiveTexture(GL_TEXTURE3);
		glBindTexture(fx_get_texture(ink_tex)->target, 0);
		glActiveTexture(GL_TEXTURE0);
		wlr_texture_destroy(ink_tex);
	}

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
}

void fx_render_pass_add_rect(struct fx_gles_render_pass *pass,
		const struct fx_render_rect_options *fx_options) {
	const struct wlr_render_rect_options *options = &fx_options->base;

	struct fx_renderer *renderer = pass->buffer->renderer;

	const struct wlr_render_color *color = &options->color;
	struct wlr_box box;
	struct wlr_buffer *wlr_buffer = pass->buffer->buffer;
	wlr_render_rect_options_get_box(options, wlr_buffer, &box);

	const bool should_clip = clipped_fregion_is_valid(&fx_options->clipped_region);

	enum wlr_render_blend_mode blend_mode =
		(color->a == 1.0 && !should_clip) ? WLR_RENDER_BLEND_MODE_NONE : options->blend_mode;
	const bool use_fast_clear =
		blend_mode == WLR_RENDER_BLEND_MODE_NONE && // includes check for `should_clip`
		options->clip == NULL &&
		box.x == 0 && box.y == 0 &&
		box.width == wlr_buffer->width &&
		box.height == wlr_buffer->height;

	TRACY_BOTH_ZONES_START(renderer);
	TRACY_ZONE_TEXT_f("Box (WxH, X, Y): %dx%d, %d, %d", box.width, box.height, box.x, box.y);
	TRACY_ZONE_TEXT_f("Color RGBA: %f, %f, %f, %f", color->r, color->g, color->b, color->a);
	TRACY_ZONE_TEXT_f("Use fast clear optimization: %d", use_fast_clear);

	push_fx_debug(renderer);
	if (use_fast_clear) {
		glClearColor(color->r, color->g, color->b, color->a);
		glClear(GL_COLOR_BUFFER_BIT);
	} else {
		const struct wlr_box *clipped_region_box = &fx_options->clipped_region.area;
		const struct fx_corner_fradii *clipped_region_corners = &fx_options->clipped_region.corners;

		TRACY_ZONE_TEXT_f("Clip Box (WxH, X, Y): %dx%d, %d, %d",
				clipped_region_box->width, clipped_region_box->height,
				clipped_region_box->x, clipped_region_box->y);
		TRACY_ZONE_TEXT_f("Clip Box Corners (TL, TR, BL, BR): %f, %f, %f, %f",
				clipped_region_corners->top_left,
				clipped_region_corners->top_right,
				clipped_region_corners->bottom_left,
				clipped_region_corners->bottom_right);

		pixman_region32_t clip_region;
		if (options->clip) {
			pixman_region32_init(&clip_region);
			pixman_region32_copy(&clip_region, options->clip);
		} else {
			pixman_region32_init_rect(&clip_region, box.x, box.y, box.width, box.height);
		}

		apply_clip_region(&clip_region, clipped_region_box, clipped_region_corners);

		setup_blending(blend_mode);
		struct quad_shader *shader = should_clip
			? &renderer->shaders.quad_clip
			: &renderer->shaders.quad;
		glUseProgram(shader->program);
		set_proj_matrix(shader->proj, pass->projection_matrix, &box);
		glUniform4f(shader->color, color->r, color->g, color->b, color->a);
		if (should_clip) {
			glUniform2f(shader->effects.clip_size, clipped_region_box->width, clipped_region_box->height);
			glUniform2f(shader->effects.clip_position, clipped_region_box->x, clipped_region_box->y);
			uniform_corner_radii_set(&shader->effects.clip_radius, clipped_region_corners);
		}
		render(&box, &clip_region, shader->pos_attrib);

		pixman_region32_fini(&clip_region);
	}

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
}

void fx_render_pass_add_rect_grad(struct fx_gles_render_pass *pass,
		const struct fx_render_rect_grad_options *fx_options) {
	const struct wlr_render_rect_options *options = &fx_options->base;

	struct fx_renderer *renderer = pass->buffer->renderer;

	if (renderer->shaders.quad_grad.max_len <= fx_options->gradient.count) {
		glDeleteProgram(renderer->shaders.quad_grad.program);
		if (!link_quad_grad_program(&renderer->shaders.quad_grad, fx_options->gradient.count + 1)) {
			wlr_log(WLR_ERROR, "Could not link quad shader after updating max_len to %d. Aborting renderer", fx_options->gradient.count + 1);
			abort();
		}
	}

	struct wlr_box box;
	struct wlr_buffer *wlr_buffer = pass->buffer->buffer;
	wlr_render_rect_options_get_box(options, wlr_buffer, &box);

	TRACY_BOTH_ZONES_START(renderer);
	TRACY_ZONE_TEXT_f("Box (WxH, X, Y): %dx%d, %d, %d", box.width, box.height, box.x, box.y);
	TRACY_ZONE_TEXT_f("Gradient:");
	TRACY_ZONE_TEXT_f("\tNum Colors: %d", fx_options->gradient.count);
	TRACY_ZONE_TEXT_f("\tBlend: %d", fx_options->gradient.blend);
	TRACY_ZONE_TEXT_f("\tDegree: %f", fx_options->gradient.degree);
	TRACY_ZONE_TEXT_f("\tType: %s",
			fx_options->gradient.linear == 1 ? "Linear"
			: fx_options->gradient.linear == 2 ? "Conic"
			: "Unknown");
	TRACY_ZONE_TEXT_f("\tOrigin: %fx%f",
			fx_options->gradient.origin[0], fx_options->gradient.origin[1]);
	TRACY_ZONE_TEXT_f("\tRange (WxH, X, Y): %dx%d, %d, %d",
			fx_options->gradient.range.width, fx_options->gradient.range.height,
			fx_options->gradient.range.x, fx_options->gradient.range.y);
	// TODO: Display Colors (not really sure how it works without a scene example...)
	push_fx_debug(renderer);

	setup_blending(options->blend_mode);

	struct quad_grad_shader shader = renderer->shaders.quad_grad;
	glUseProgram(shader.program);

	set_proj_matrix(shader.proj, pass->projection_matrix, &box);
	glUniform4fv(shader.colors, fx_options->gradient.count, (GLfloat*)fx_options->gradient.colors);
	glUniform1i(shader.count, fx_options->gradient.count);
	glUniform2f(shader.size, fx_options->gradient.range.width, fx_options->gradient.range.height);
	glUniform1f(shader.degree, fx_options->gradient.degree);
	glUniform1f(shader.linear, fx_options->gradient.linear);
	glUniform1f(shader.blend, fx_options->gradient.blend);
	glUniform2f(shader.grad_box, fx_options->gradient.range.x, fx_options->gradient.range.y);
	glUniform2f(shader.origin, fx_options->gradient.origin[0], fx_options->gradient.origin[1]);

	render(&box, options->clip, shader.pos_attrib);

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
}

void fx_render_pass_add_rounded_rect(struct fx_gles_render_pass *pass,
		const struct fx_render_rounded_rect_options *fx_options) {
	const struct wlr_render_rect_options *options = &fx_options->base;

	struct fx_renderer *renderer = pass->buffer->renderer;

	const struct wlr_render_color *color = &options->color;
	struct wlr_box box;
	struct wlr_buffer *wlr_buffer = pass->buffer->buffer;
	wlr_render_rect_options_get_box(options, wlr_buffer, &box);

	pixman_region32_t clip_region;
	if (options->clip) {
		pixman_region32_init(&clip_region);
		pixman_region32_copy(&clip_region, options->clip);
	} else {
		pixman_region32_init_rect(&clip_region, box.x, box.y, box.width, box.height);
	}
	const struct wlr_box *clipped_region_box = &fx_options->clipped_region.area;
	const struct fx_corner_fradii *clipped_region_corners = &fx_options->clipped_region.corners;
	apply_clip_region(&clip_region, clipped_region_box, clipped_region_corners);

	TRACY_BOTH_ZONES_START(renderer);
	TRACY_ZONE_TEXT_f("Box (WxH, X, Y): %dx%d, %d, %d", box.width, box.height, box.x, box.y);
	TRACY_ZONE_TEXT_f("Clip Box (WxH, X, Y): %dx%d, %d, %d",
			clipped_region_box->width, clipped_region_box->height,
			clipped_region_box->x, clipped_region_box->y);
	TRACY_ZONE_TEXT_f("Clip Box Corners (TL, TR, BL, BR): %f, %f, %f, %f",
			clipped_region_corners->top_left,
			clipped_region_corners->top_right,
			clipped_region_corners->bottom_left,
			clipped_region_corners->bottom_right);
	TRACY_ZONE_TEXT_f("Color RGBA: %f, %f, %f, %f", color->r, color->g, color->b, color->a);
	TRACY_ZONE_TEXT_f("Corners (TL, TR, BL, BR): %f, %f, %f, %f",
			clipped_region_corners->top_left,
			clipped_region_corners->top_right,
			clipped_region_corners->bottom_left,
			clipped_region_corners->bottom_right);
	push_fx_debug(renderer);

	setup_blending(WLR_RENDER_BLEND_MODE_PREMULTIPLIED);

	struct quad_round_shader shader = renderer->shaders.quad_round;

	glUseProgram(shader.program);

	set_proj_matrix(shader.proj, pass->projection_matrix, &box);
	glUniform4f(shader.color, color->r, color->g, color->b, color->a);

	glUniform2f(shader.size, box.width, box.height);
	glUniform2f(shader.position, box.x, box.y);
	glUniform2f(shader.clip_size, clipped_region_box->width, clipped_region_box->height);
	glUniform2f(shader.clip_position, clipped_region_box->x, clipped_region_box->y);
	uniform_corner_radii_set(&shader.clip_radius, clipped_region_corners);

	struct fx_corner_fradii corners = fx_options->corners;
	uniform_corner_radii_set(&shader.radius, &corners);

	render(&box, &clip_region, renderer->shaders.quad_round.pos_attrib);
	pixman_region32_fini(&clip_region);

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
}

void fx_render_pass_add_rounded_rect_grad(struct fx_gles_render_pass *pass,
		const struct fx_render_rounded_rect_grad_options *fx_options) {
	const struct wlr_render_rect_options *options = &fx_options->base;

	struct fx_renderer *renderer = pass->buffer->renderer;

	if (renderer->shaders.quad_grad_round.max_len <= fx_options->gradient.count) {
		glDeleteProgram(renderer->shaders.quad_grad_round.program);
		if (!link_quad_grad_round_program(&renderer->shaders.quad_grad_round, fx_options->gradient.count + 1)) {
			wlr_log(WLR_ERROR, "Could not link quad shader after updating max_len to %d. Aborting renderer", fx_options->gradient.count + 1);
			abort();
		}
	}

	struct wlr_box box;
	struct wlr_buffer *wlr_buffer = pass->buffer->buffer;
	wlr_render_rect_options_get_box(options, wlr_buffer, &box);

	TRACY_BOTH_ZONES_START(renderer);
	TRACY_ZONE_TEXT_f("Box (WxH, X, Y): %dx%d, %d, %d", box.width, box.height, box.x, box.y);
	TRACY_ZONE_TEXT_f("Corners (TL, TR, BL, BR): %f, %f, %f, %f",
			fx_options->corners.top_left,
			fx_options->corners.top_right,
			fx_options->corners.bottom_left,
			fx_options->corners.bottom_right);
	TRACY_ZONE_TEXT_f("Gradient:");
	TRACY_ZONE_TEXT_f("\tNum Colors: %d", fx_options->gradient.count);
	TRACY_ZONE_TEXT_f("\tBlend: %d", fx_options->gradient.blend);
	TRACY_ZONE_TEXT_f("\tDegree: %f", fx_options->gradient.degree);
	TRACY_ZONE_TEXT_f("\tType: %s",
			fx_options->gradient.linear == 1 ? "Linear"
			: fx_options->gradient.linear == 2 ? "Conic"
			: "Unknown");
	TRACY_ZONE_TEXT_f("\tOrigin: %fx%f",
			fx_options->gradient.origin[0], fx_options->gradient.origin[1]);
	TRACY_ZONE_TEXT_f("\tRange (WxH, X, Y): %dx%d, %d, %d",
			fx_options->gradient.range.width, fx_options->gradient.range.height,
			fx_options->gradient.range.x, fx_options->gradient.range.y);
	// TODO: Display Colors (not really sure how it works without a scene example...)
	push_fx_debug(renderer);

	setup_blending(WLR_RENDER_BLEND_MODE_PREMULTIPLIED);

	struct quad_grad_round_shader shader = renderer->shaders.quad_grad_round;
	glUseProgram(shader.program);

	set_proj_matrix(shader.proj, pass->projection_matrix, &box);

	glUniform2f(shader.size, box.width, box.height);
	glUniform2f(shader.position, box.x, box.y);

	glUniform4fv(shader.colors, fx_options->gradient.count, (GLfloat*)fx_options->gradient.colors);
	glUniform1i(shader.count, fx_options->gradient.count);
	glUniform2f(shader.grad_size, fx_options->gradient.range.width, fx_options->gradient.range.height);
	glUniform1f(shader.degree, fx_options->gradient.degree);
	glUniform1f(shader.linear, fx_options->gradient.linear);
	glUniform1f(shader.blend, fx_options->gradient.blend);
	glUniform2f(shader.grad_box, fx_options->gradient.range.x, fx_options->gradient.range.y);
	glUniform2f(shader.origin, fx_options->gradient.origin[0], fx_options->gradient.origin[1]);

	struct fx_corner_fradii corners = fx_options->corners;
	uniform_corner_radii_set(&shader.radius, &corners);

	render(&box, options->clip, shader.pos_attrib);

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
}

void fx_render_pass_add_box_shadow(struct fx_gles_render_pass *pass,
		const struct fx_render_box_shadow_options *options) {
	struct fx_renderer *renderer = pass->buffer->renderer;

	struct wlr_box box = options->box;
	assert(box.width > 0 && box.height > 0);
	if (options->blur_sigma <= 0.0f) {
		fx_render_pass_add_rounded_rect(pass,
				&(struct fx_render_rounded_rect_options){
			.base = {
				.box = box,
				.color = options->color,
				.clip = options->clip,
			},
			.corners = {
				.top_left = options->corner_radius,
				.top_right = options->corner_radius,
				.bottom_right = options->corner_radius,
				.bottom_left = options->corner_radius,
			},
			.clipped_region = options->clipped_region,
		});
		return;
	}

	pixman_region32_t clip_region;
	if (options->clip) {
		pixman_region32_init(&clip_region);
		pixman_region32_copy(&clip_region, options->clip);
	} else {
		pixman_region32_init_rect(&clip_region, box.x, box.y, box.width, box.height);
	}
	const struct wlr_box clipped_region_box = options->clipped_region.area;
	struct fx_corner_fradii clipped_region_corners = options->clipped_region.corners;
	apply_clip_region(&clip_region, &clipped_region_box, &clipped_region_corners);

	TRACY_BOTH_ZONES_START(renderer);
	TRACY_ZONE_TEXT_f("Box (WxH, X, Y): %dx%d, %d, %d", box.width, box.height, box.x, box.y);
	TRACY_ZONE_TEXT_f("Clip Box (WxH, X, Y): %dx%d, %d, %d",
			clipped_region_box.width, clipped_region_box.height,
			clipped_region_box.x, clipped_region_box.y);
	TRACY_ZONE_TEXT_f("Clip Box Corners (TL, TR, BL, BR): %f, %f, %f, %f",
			clipped_region_corners.top_left,
			clipped_region_corners.top_right,
			clipped_region_corners.bottom_left,
			clipped_region_corners.bottom_right);
	TRACY_ZONE_TEXT_f("Shadow Options:");
	TRACY_ZONE_TEXT_f("\tColor RGBA: %f, %f, %f, %f",
			options->color.r, options->color.g, options->color.b, options->color.a);
	TRACY_ZONE_TEXT_f("\tBlur Sigma: %f", options->blur_sigma);
	push_fx_debug(renderer);

	// Blurred edges require blending, so just enable it
	setup_blending(WLR_RENDER_BLEND_MODE_PREMULTIPLIED);
	glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

	glUseProgram(renderer->shaders.box_shadow.program);

	const struct wlr_render_color *color = &options->color;
	set_proj_matrix(renderer->shaders.box_shadow.proj, pass->projection_matrix, &box);
	glUniform4f(renderer->shaders.box_shadow.color, color->r, color->g, color->b, color->a);
	glUniform1f(renderer->shaders.box_shadow.blur_sigma, options->blur_sigma);
	glUniform2f(renderer->shaders.box_shadow.size, box.width, box.height);
	glUniform2f(renderer->shaders.box_shadow.position, box.x, box.y);
	glUniform1f(renderer->shaders.box_shadow.corner_radius, options->corner_radius);

	uniform_corner_radii_set(&renderer->shaders.box_shadow.clip_radius, &clipped_region_corners);

	glUniform2f(renderer->shaders.box_shadow.clip_position, clipped_region_box.x, clipped_region_box.y);
	glUniform2f(renderer->shaders.box_shadow.clip_size, clipped_region_box.width, clipped_region_box.height);

	render(&box, &clip_region, renderer->shaders.box_shadow.pos_attrib);
	pixman_region32_fini(&clip_region);

	glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
}

// Renders the blur for each damaged rect and swaps the buffer
static void render_blur_segments(struct fx_gles_render_pass *pass,
		struct fx_render_blur_pass_options *fx_options, struct blur_shader* shader) {
	struct fx_render_texture_options *tex_options = &fx_options->tex_options;
	struct wlr_render_texture_options *options = &tex_options->base;
	struct fx_renderer *renderer = pass->buffer->renderer;
	struct blur_data *blur_data = fx_options->blur_data;

	TRACY_BOTH_ZONES_START(renderer);
	push_fx_debug(renderer);

	// Swap fbo
	if (fx_options->current_buffer == pass->fx_offscreen_buffers->effects_buffer) {
		fx_framebuffer_bind(pass->fx_offscreen_buffers->effects_buffer_swapped);
	} else {
		fx_framebuffer_bind(pass->fx_offscreen_buffers->effects_buffer);
	}

	options->texture = fx_texture_from_buffer(&renderer->wlr_renderer,
			fx_options->current_buffer->buffer);
	struct fx_texture *texture = fx_get_texture(options->texture);

	/*
	 * Render
	 */

	struct wlr_box dst_box;
	struct wlr_fbox src_fbox;
	wlr_render_texture_options_get_src_box(options, &src_fbox);
	wlr_render_texture_options_get_dst_box(options, &dst_box);
	src_fbox.x /= options->texture->width;
	src_fbox.y /= options->texture->height;
	src_fbox.width /= options->texture->width;
	src_fbox.height /= options->texture->height;

	glDisable(GL_BLEND);
	glDisable(GL_STENCIL_TEST);

	glUseProgram(shader->program);

	glActiveTexture(GL_TEXTURE0);
	glBindTexture(texture->target, texture->tex);

	switch (options->filter_mode) {
	case WLR_SCALE_FILTER_BILINEAR:
		glTexParameteri(texture->target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(texture->target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		break;
	case WLR_SCALE_FILTER_NEAREST:
		abort();
	}

	glUniform1i(shader->tex, 0);
	glUniform1f(shader->radius, blur_data->radius);

	if (shader == &renderer->shaders.blur1) {
		glUniform2f(shader->halfpixel,
				0.5f / (options->texture->width / 2.0f),
				0.5f / (options->texture->height / 2.0f));
	} else {
		glUniform2f(shader->halfpixel,
				0.5f / (options->texture->width * 2.0f),
				0.5f / (options->texture->height * 2.0f));
	}

	set_proj_matrix(shader->proj, pass->projection_matrix, &dst_box);
	set_tex_matrix(shader->tex_proj, options->transform, &src_fbox);

	render(&dst_box, options->clip, shader->pos_attrib);

	glBindTexture(texture->target, 0);
	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;

	wlr_texture_destroy(options->texture);

	// Swap buffer. We don't want to draw to the same buffer
	if (fx_options->current_buffer != pass->fx_offscreen_buffers->effects_buffer) {
		fx_options->current_buffer = pass->fx_offscreen_buffers->effects_buffer;
	} else {
		fx_options->current_buffer = pass->fx_offscreen_buffers->effects_buffer_swapped;
	}
}

static void render_blur_effects(struct fx_gles_render_pass *pass,
		struct fx_render_blur_pass_options *fx_options) {
	struct fx_render_texture_options *tex_options = &fx_options->tex_options;
	struct wlr_render_texture_options *options = &tex_options->base;
	struct fx_renderer *renderer = pass->buffer->renderer;
	struct blur_data *blur_data = fx_options->blur_data;
	struct fx_texture *texture = fx_get_texture(options->texture);

	struct blur_effects_shader shader = renderer->shaders.blur_effects;

	struct wlr_box dst_box;
	struct wlr_fbox src_fbox;
	wlr_render_texture_options_get_src_box(options, &src_fbox);
	wlr_render_texture_options_get_dst_box(options, &dst_box);

	src_fbox.x /= options->texture->width;
	src_fbox.y /= options->texture->height;
	src_fbox.width /= options->texture->width;
	src_fbox.height /= options->texture->height;

	glDisable(GL_BLEND);
	glDisable(GL_STENCIL_TEST);

	TRACY_BOTH_ZONES_START(renderer);
	push_fx_debug(renderer);

	glUseProgram(shader.program);

	glActiveTexture(GL_TEXTURE0);
	glBindTexture(texture->target, texture->tex);

	switch (options->filter_mode) {
	case WLR_SCALE_FILTER_BILINEAR:
		glTexParameteri(texture->target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(texture->target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		break;
	case WLR_SCALE_FILTER_NEAREST:
		abort();
	}

	glUniform1i(shader.tex, 0);
	glUniform1f(shader.noise, blur_data->noise);
	glUniform1f(shader.brightness, blur_data->brightness);
	glUniform1f(shader.contrast, blur_data->contrast);
	glUniform1f(shader.saturation, blur_data->saturation);

	set_proj_matrix(shader.proj, pass->projection_matrix, &dst_box);
	set_tex_matrix(shader.tex_proj, options->transform, &src_fbox);

	render(&dst_box, options->clip, shader.pos_attrib);

	glBindTexture(texture->target, 0);

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;

	wlr_texture_destroy(options->texture);
}

// Blurs the fx_options current_buffer content and returns the blurred framebuffer.
// Returns NULL when the blur parameters reach 0.
static struct fx_framebuffer *get_main_buffer_blur(struct fx_gles_render_pass *pass,
		struct fx_render_blur_pass_options *fx_options) {
	if (pass->fx_offscreen_buffers == NULL) {
		wlr_log(WLR_ERROR, "FX Pass offscreen buffers not initialized. Skipping getting blur...");
		return NULL;
	}

	struct fx_renderer *renderer = pass->buffer->renderer;
	struct wlr_box buffer_bounds = {
		0, 0,
		fx_options->current_buffer->buffer->width, fx_options->current_buffer->buffer->height
	};

	// We don't want to affect the reference blur_data
	struct blur_data blur_data = blur_data_apply_strength(fx_options->blur_data, fx_options->blur_strength);
	if (fx_options->blur_strength <= 0 || !is_scene_blur_enabled(&blur_data)) {
		return NULL;
	}
	fx_options->blur_data = &blur_data;
	fx_options->tex_options.base.transform = WL_OUTPUT_TRANSFORM_NORMAL;

	pixman_region32_t damage;
	pixman_region32_init(&damage);
	pixman_region32_copy(&damage, fx_options->tex_options.base.clip);

	wlr_region_expand(&damage, &damage, blur_data_calc_size(&blur_data));
	// Make sure that the region doesn't expand past the buffer bounds
	pixman_region32_intersect_rect(&damage, &damage,
			0, 0, buffer_bounds.width, buffer_bounds.height);

	// damage region will be scaled, make a temp
	pixman_region32_t scaled_damage;
	pixman_region32_init(&scaled_damage);

	fx_options->tex_options.base.src_box = (struct wlr_fbox) {
		0, 0,
		buffer_bounds.width, buffer_bounds.height,
	};
	fx_options->tex_options.base.dst_box = buffer_bounds;
	// Clip the blur to the damage
	fx_options->tex_options.base.clip = &scaled_damage;
	// Artifacts with NEAREST filter
	fx_options->tex_options.base.filter_mode = WLR_SCALE_FILTER_BILINEAR;

	TRACY_BOTH_ZONES_START(renderer);
	TRACY_ZONE_TEXT_f("dst_box (WxH, X, Y): %dx%d, %d, %d",
			fx_options->tex_options.base.dst_box.width,
			fx_options->tex_options.base.dst_box.height,
			fx_options->tex_options.base.dst_box.x,
			fx_options->tex_options.base.dst_box.y);
	TRACY_ZONE_TEXT_f("clip_box (WxH, X, Y): %dx%d, %d, %d",
			fx_options->tex_options.clip_box->width,
			fx_options->tex_options.clip_box->height,
			fx_options->tex_options.clip_box->x,
			fx_options->tex_options.clip_box->y);
	TRACY_ZONE_TEXT_f("Corners (TL, TR, BL, BR): %f, %f, %f, %f",
			fx_options->corners.top_left,
			fx_options->corners.top_right,
			fx_options->corners.bottom_left,
			fx_options->corners.bottom_right);
	TRACY_ZONE_TEXT_f("src_box (WxH, X, Y): %lfx%lf, %lf, %lf",
			fx_options->tex_options.base.src_box.width,
			fx_options->tex_options.base.src_box.height,
			fx_options->tex_options.base.src_box.x,
			fx_options->tex_options.base.src_box.y);
	TRACY_ZONE_TEXT_f("Ignore Transparent: %d", fx_options->ignore_transparent);
	TRACY_ZONE_TEXT_f("Discard Transparent: %d", fx_options->tex_options.discard_transparent);
	TRACY_ZONE_TEXT_f("Use Optimized Blur: %d", fx_options->use_optimized_blur);
	TRACY_ZONE_TEXT_f("Blur Options:");
	TRACY_ZONE_TEXT_f("\tNum Blur Passes: %d", fx_options->blur_data->num_passes);
	TRACY_ZONE_TEXT_f("\tBlur Radius: %f", fx_options->blur_data->radius);
	TRACY_ZONE_TEXT_f("\tBrightness: %f", fx_options->blur_data->brightness);
	TRACY_ZONE_TEXT_f("\tContrast: %f", fx_options->blur_data->contrast);
	TRACY_ZONE_TEXT_f("\tNoise: %f", fx_options->blur_data->noise);
	TRACY_ZONE_TEXT_f("\tSaturation: %f", fx_options->blur_data->saturation);
	push_fx_debug(renderer);

	// Downscale
	for (int i = 0; i < blur_data.num_passes; ++i) {
		wlr_region_scale(&scaled_damage, &damage, 1.0f / (1 << (i + 1)));
		render_blur_segments(pass, fx_options, &renderer->shaders.blur1);
	}

	// Upscale
	for (int i = blur_data.num_passes - 1; i >= 0; --i) {
		// when upsampling we make the region twice as big
		wlr_region_scale(&scaled_damage, &damage, 1.0f / (1 << i));
		render_blur_segments(pass, fx_options, &renderer->shaders.blur2);
	}

	pixman_region32_fini(&scaled_damage);

	// Render additional blur effects like saturation, noise, contrast, etc...
	if (blur_data_should_parameters_blur_effects(&blur_data)
			&& pixman_region32_not_empty(&damage)) {
		if (fx_options->current_buffer == pass->fx_offscreen_buffers->effects_buffer) {
			fx_framebuffer_bind(pass->fx_offscreen_buffers->effects_buffer_swapped);
		} else {
			fx_framebuffer_bind(pass->fx_offscreen_buffers->effects_buffer);
		}
		fx_options->tex_options.base.clip = &damage;
		fx_options->tex_options.base.texture = fx_texture_from_buffer(
				&renderer->wlr_renderer, fx_options->current_buffer->buffer);
		render_blur_effects(pass, fx_options);
		if (fx_options->current_buffer != pass->fx_offscreen_buffers->effects_buffer) {
			fx_options->current_buffer = pass->fx_offscreen_buffers->effects_buffer;
		} else {
			fx_options->current_buffer = pass->fx_offscreen_buffers->effects_buffer_swapped;
		}
	}

	pixman_region32_fini(&damage);

	// Bind back to the default buffer
	fx_framebuffer_bind(pass->buffer);

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;

	return fx_options->current_buffer;
}

// swayctl: keep what is behind `pane` (the copy the glass is about to bend)
// for a backdrop probe -- the pane's own content isn't drawn yet. Only the
// parts this frame redraws (`clip`) are fresh: those are copied into the
// probe's image; it's ready once the whole pane has been seen.
// swayctl: shrink [x, y, w x h] of `buffer` by `sub` (block means) and read
// the down rects `rects` (in shrunk px, relative to x/y) into `rgb`
// (`dw` px wide). The readback is then 1/sub² the size: a full-size one of a
// window stalled the render loop for 6-16 ms - a dropped frame per probe.
static bool probe_read_down(struct fx_renderer *renderer, struct fx_framebuffer *buffer,
		int x, int y, int sub, int dw, int dh, const pixman_region32_t *rects_down,
		unsigned char *rgb, unsigned char *seen, size_t *filled) {
	if (dw > renderer->probe_down.width || dh > renderer->probe_down.height) {
		int w = dw > renderer->probe_down.width ? dw : renderer->probe_down.width;
		int h = dh > renderer->probe_down.height ? dh : renderer->probe_down.height;
		if (!renderer->probe_down.tex) {
			glGenTextures(1, &renderer->probe_down.tex);
			glGenFramebuffers(1, &renderer->probe_down.fbo);
		}
		glBindTexture(GL_TEXTURE_2D, renderer->probe_down.tex);
		glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
		glBindTexture(GL_TEXTURE_2D, 0);
		renderer->probe_down.width = w;
		renderer->probe_down.height = h;
	}
	const int tw = renderer->probe_down.width, th = renderer->probe_down.height;
	struct wlr_texture *src_tex = fx_texture_from_buffer(&renderer->wlr_renderer, buffer->buffer);
	if (!src_tex) {
		return false;
	}
	struct fx_texture *src = fx_get_texture(src_tex);

	GLint prev_fbo = 0;
	GLint prev_viewport[4];
	glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prev_fbo);
	glGetIntegerv(GL_VIEWPORT, prev_viewport);
	GLboolean stencil = glIsEnabled(GL_STENCIL_TEST);
	GLboolean blend = glIsEnabled(GL_BLEND);
	glDisable(GL_STENCIL_TEST);
	glDisable(GL_BLEND);

	glBindFramebuffer(GL_FRAMEBUFFER, renderer->probe_down.fbo);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
		renderer->probe_down.tex, 0);
	bool ok = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
	if (ok) {
		struct probe_down_shader shader = renderer->shaders.probe_down;
		glViewport(0, 0, tw, th);
		glUseProgram(shader.program);
		glActiveTexture(GL_TEXTURE0);
		glBindTexture(src->target, src->tex);
		glTexParameteri(src->target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(src->target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		glUniform1i(shader.tex, 0);
		glUniform2f(shader.tex_size, src->wlr_texture.width, src->wlr_texture.height);
		glUniform2f(shader.origin, x, y);
		glUniform2f(shader.out_span, tw, th);
		glUniform1f(shader.sub, sub);
		float proj[9];
		matrix_projection(proj, tw, th, WL_OUTPUT_TRANSFORM_FLIPPED_180);
		struct wlr_box box = { .x = 0, .y = 0, .width = tw, .height = th };
		struct wlr_fbox fsrc = { .x = 0, .y = 0, .width = 1, .height = 1 };
		set_proj_matrix(shader.proj, proj, &box);
		set_tex_matrix(shader.tex_proj, WL_OUTPUT_TRANSFORM_NORMAL, &fsrc);
		render(&box, rects_down, shader.pos_attrib);
		glBindTexture(src->target, 0);

		GLint pack = 4;
		glGetIntegerv(GL_PACK_ALIGNMENT, &pack);
		glPixelStorei(GL_PACK_ALIGNMENT, 1);
		int nrects = 0;
		const pixman_box32_t *r = pixman_region32_rectangles(
			(pixman_region32_t *)rects_down, &nrects);
		for (int i = 0; i < nrects; i++) {
			int rw = r[i].x2 - r[i].x1, rh = r[i].y2 - r[i].y1;
			unsigned char *tmp = malloc((size_t)rw * (size_t)rh * 4);
			if (!tmp) {
				continue;
			}
			while (glGetError() != GL_NO_ERROR) { }
			// scenefx targets hold the image top-down (see fx_renderer_read_buffer_pixels)
			glReadPixels(r[i].x1, r[i].y1, rw, rh, GL_RGBA, GL_UNSIGNED_BYTE, tmp);
			if (glGetError() == GL_NO_ERROR) {
				for (int row = 0; row < rh; row++) {
					size_t dst = (size_t)(r[i].y1 + row) * (size_t)dw + (size_t)r[i].x1;
					const unsigned char *sp = tmp + (size_t)row * (size_t)rw * 4;
					for (int col = 0; col < rw; col++) {
						rgb[(dst + col) * 3] = sp[col * 4];
						rgb[(dst + col) * 3 + 1] = sp[col * 4 + 1];
						rgb[(dst + col) * 3 + 2] = sp[col * 4 + 2];
						*filled += !seen[dst + col];
						seen[dst + col] = 1;
					}
				}
			}
			free(tmp);
		}
		glPixelStorei(GL_PACK_ALIGNMENT, pack);
	}

	glBindFramebuffer(GL_FRAMEBUFFER, prev_fbo);
	glViewport(prev_viewport[0], prev_viewport[1], prev_viewport[2], prev_viewport[3]);
	if (stencil) {
		glEnable(GL_STENCIL_TEST);
	}
	if (blend) {
		glEnable(GL_BLEND);
	}
	wlr_texture_destroy(src_tex);
	return ok;
}

static void backdrop_probe_grab(struct fx_backdrop_probe *probe, struct fx_renderer *renderer,
		struct fx_framebuffer *buffer, const struct wlr_box *pane, const pixman_region32_t *clip) {
	int bw = buffer->buffer->width, bh = buffer->buffer->height;
	int x0 = pane->x < 0 ? 0 : pane->x, y0 = pane->y < 0 ? 0 : pane->y;
	int x1 = pane->x + pane->width > bw ? bw : pane->x + pane->width;
	int y1 = pane->y + pane->height > bh ? bh : pane->y + pane->height;
	int w = x1 - x0, h = y1 - y0;
	if (w < 1 || h < 1) {
		return;
	}
	// big panes (windows) are shrunk on the GPU first: what's read back stays
	// around 64k px whatever the pane's size
	long area = (long)w * h;
	int sub = area <= 128L * 1024 ? 1 : area <= 512L * 1024 ? 2 : area <= 2048L * 1024 ? 4 : 8;
	int dw = w / sub, dh = h / sub;
	if (dw < 1 || dh < 1) {
		sub = 1;
		dw = w;
		dh = h;
	}
	size_t need = (size_t)dw * (size_t)dh;
	if (dw != probe->width || dh != probe->height || x0 != probe->x || y0 != probe->y
			|| sub != (probe->sub ? probe->sub : 1)) {
		if (probe->cap < need * 3) {
			unsigned char *grown = realloc(probe->rgb, need * 3);
			if (!grown) {
				return;
			}
			probe->rgb = grown;
			probe->cap = need * 3;
		}
		if (probe->seen_cap < need) {
			unsigned char *grown = realloc(probe->seen, need);
			if (!grown) {
				return;
			}
			probe->seen = grown;
			probe->seen_cap = need;
		}
		memset(probe->seen, 0, need);
		probe->filled = 0;
		probe->width = dw;
		probe->height = dh;
		probe->sub = sub;
		probe->x = x0;
		probe->y = y0;
		probe->complete = false;
		probe->ready = false;
	}

	pixman_region32_t fresh;
	pixman_region32_init_rect(&fresh, x0, y0, w, h);
	if (clip) {
		pixman_region32_intersect(&fresh, &fresh, (pixman_region32_t *)clip);
	}
	size_t filled_before = probe->filled;
	int nrects = 0;
	const pixman_box32_t *rects = pixman_region32_rectangles(&fresh, &nrects);
	if (sub > 1) {
		// only shrunk px whose whole block is fresh: the rest of the copy is
		// whatever an earlier frame (or another pane) left there
		pixman_region32_t down;
		pixman_region32_init(&down);
		for (int i = 0; i < nrects; i++) {
			int dx1 = (rects[i].x1 - x0 + sub - 1) / sub, dy1 = (rects[i].y1 - y0 + sub - 1) / sub;
			int dx2 = (rects[i].x2 - x0) / sub, dy2 = (rects[i].y2 - y0) / sub;
			dx2 = dx2 > dw ? dw : dx2;
			dy2 = dy2 > dh ? dh : dy2;
			if (dx2 > dx1 && dy2 > dy1) {
				pixman_region32_union_rect(&down, &down, dx1, dy1, dx2 - dx1, dy2 - dy1);
			}
		}
		if (pixman_region32_not_empty(&down)) {
			probe_read_down(renderer, buffer, x0, y0, sub, dw, dh, &down,
				probe->rgb, probe->seen, &probe->filled);
		}
		pixman_region32_fini(&down);
		nrects = 0;  // done
	}
	for (int i = 0; i < nrects; i++) {
		int rx = rects[i].x1, ry = rects[i].y1;
		int rw = rects[i].x2 - rx, rh = rects[i].y2 - ry;
		if (rw < 1 || rh < 1) {
			continue;
		}
		unsigned char *tmp = malloc((size_t)rw * (size_t)rh * 3);
		if (!tmp) {
			continue;
		}
		if (fx_renderer_read_buffer_pixels(&renderer->wlr_renderer, buffer->buffer,
				rx, ry, rw, rh, tmp)) {
			for (int row = 0; row < rh; row++) {
				size_t dst = ((size_t)(ry - y0 + row) * (size_t)w + (size_t)(rx - x0));
				memcpy(probe->rgb + dst * 3, tmp + (size_t)row * (size_t)rw * 3, (size_t)rw * 3);
				for (int col = 0; col < rw; col++) {
					probe->filled += !probe->seen[dst + col];
				}
				memset(probe->seen + dst, 1, (size_t)rw);
			}
		}
		free(tmp);
	}
	nrects = pixman_region32_n_rects(&fresh);
	pixman_region32_fini(&fresh);

	// Whole once a frame adds nothing new: what's still unseen is outside
	// the pane's shape (a pill's rounded corners, a shaped window's clear
	// margins), which no frame ever draws. Waiting for every pixel of the
	// box kept a redraw forced on every request - ghosts, and never ready.
	if (!probe->complete && nrects > 0 && probe->filled > 0
			&& (probe->filled == filled_before || probe->filled == need)) {
		probe->complete = true;
	}
	if (probe->complete && nrects > 0) {
		probe->want = false;
		probe->ready = true;
	}
}

// swayctl: a shaped pane's field texel covers this many px per side. The
// field (distance to the outline, its normal) is smooth, so 1/16 of the
// pixels carry it and the glass reads it back bilinearly.
#define GLASS_FIELD_SCALE 4

// swayctl: the cache entry for a shaped pane's field: its own if it has
// one, else the least recently drawn one (whose texels are then all stale)
static struct glass_field_entry *glass_field_entry(struct fx_renderer *renderer, uint64_t id) {
	const size_t n = sizeof(renderer->glass_fields) / sizeof(renderer->glass_fields[0]);
	struct glass_field_entry *lru = &renderer->glass_fields[0];
	for (size_t i = 0; i < n; i++) {
		struct glass_field_entry *e = &renderer->glass_fields[i];
		if (id != 0 && e->id == id && e->tex) {
			return e;
		}
		if (e->used < lru->used) {
			lru = e;
		}
	}
	if (!lru->tex) {
		pixman_region32_init(&lru->valid);
	} else {
		pixman_region32_clear(&lru->valid);
	}
	lru->id = id;
	return lru;
}

// swayctl: the shape field of a shaped glass pane (glass_field.frag) for
// the part of it that `clip` redraws. Fields are kept per pane between
// frames: only texels the client redrew near (`state->dirty`, as far as the
// bezel reaches) or that were never worked out are recomputed — a new
// backdrop, the window moving or another pane's damage reuse it as is.
// Returns the texture to sample, or 0 (no field: the glass falls back to a
// box) if the target can't be made.
static GLuint render_glass_field(struct fx_renderer *renderer, struct fx_glass_field_state *state,
		const struct wlr_box *pane, const pixman_region32_t *clip, float edge,
		struct fx_texture *mask, const float mask_src[4], float field_span[2]) {
	const int scale = GLASS_FIELD_SCALE;
	int fw = (pane->width + scale - 1) / scale + 2;
	int fh = (pane->height + scale - 1) / scale + 2;
	struct glass_field_entry *e = glass_field_entry(renderer, state ? state->id : 0);
	e->used = ++renderer->glass_field_clock;
	if (!state) {
		pixman_region32_clear(&e->valid);
	}
	if (fw > e->tex_w || fh > e->tex_h) {
		// grow with some slack so a window being resized doesn't realloc every frame
		int w = fw > e->tex_w ? fw + fw / 4 : e->tex_w;
		int h = fh > e->tex_h ? fh + fh / 4 : e->tex_h;
		if (!e->tex) {
			glGenTextures(1, &e->tex);
			glGenFramebuffers(1, &e->fbo);
		}
		glBindTexture(GL_TEXTURE_2D, e->tex);
		glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
		glBindTexture(GL_TEXTURE_2D, 0);
		e->tex_w = w;
		e->tex_h = h;
		pixman_region32_clear(&e->valid);
	}
	if (e->pane_w != pane->width || e->pane_h != pane->height || e->edge != edge
			|| memcmp(e->mask_src, mask_src, sizeof(e->mask_src)) != 0) {
		e->pane_w = pane->width;
		e->pane_h = pane->height;
		e->edge = edge;
		memcpy(e->mask_src, mask_src, sizeof(e->mask_src));
		pixman_region32_clear(&e->valid);
	}
	const int tw = e->tex_w;
	const int th = e->tex_h;
	field_span[0] = (float)tw * scale;
	field_span[1] = (float)th * scale;

	// what the client redrew, from its buffer px to field texels, grown by
	// the bezel: a texel's value depends on the mask that far around it
	if (state) {
		if (state->all_dirty) {
			pixman_region32_clear(&e->valid);
		} else if (pixman_region32_not_empty(&state->dirty)) {
			float tex_w = mask->wlr_texture.width, tex_h = mask->wlr_texture.height;
			float sx = pane->width / (mask_src[2] * tex_w) / scale;
			float sy = pane->height / (mask_src[3] * tex_h) / scale;
			int reach = (int)ceilf(fmaxf(edge, 16.0f) / scale) + 2;
			int nrects;
			const pixman_box32_t *r = pixman_region32_rectangles(&state->dirty, &nrects);
			pixman_region32_t stale;
			pixman_region32_init(&stale);
			for (int i = 0; i < nrects; i++) {
				int x1 = (int)floorf((r[i].x1 - mask_src[0] * tex_w) * sx) - reach;
				int y1 = (int)floorf((r[i].y1 - mask_src[1] * tex_h) * sy) - reach;
				int x2 = (int)ceilf((r[i].x2 - mask_src[0] * tex_w) * sx) + reach;
				int y2 = (int)ceilf((r[i].y2 - mask_src[1] * tex_h) * sy) + reach;
				pixman_region32_union_rect(&stale, &stale, x1, y1, x2 - x1, y2 - y1);
			}
			pixman_region32_subtract(&e->valid, &e->valid, &stale);
			pixman_region32_fini(&stale);
		}
		pixman_region32_clear(&state->dirty);
		state->all_dirty = false;
	}

	// the field texels under what is redrawn (+1 texel so bilinear reads at
	// the clip's edge have both neighbours), less those still up to date
	pixman_region32_t todo;
	pixman_region32_init_rect(&todo, pane->x, pane->y, pane->width, pane->height);
	if (clip) {
		pixman_region32_intersect(&todo, &todo, clip);
	}
	if (!pixman_region32_not_empty(&todo)) {
		pixman_region32_fini(&todo);
		return e->tex;
	}
	pixman_box32_t *ext = pixman_region32_extents(&todo);
	int x1 = (int)floorf((float)(ext->x1 - pane->x) / scale) - 1;
	int y1 = (int)floorf((float)(ext->y1 - pane->y) / scale) - 1;
	int x2 = (int)ceilf((float)(ext->x2 - pane->x) / scale) + 1;
	int y2 = (int)ceilf((float)(ext->y2 - pane->y) / scale) + 1;
	x1 = x1 < 0 ? 0 : x1;
	y1 = y1 < 0 ? 0 : y1;
	x2 = x2 > fw ? fw : x2;
	y2 = y2 > fh ? fh : y2;
	if (x2 <= x1 || y2 <= y1) {
		pixman_region32_fini(&todo);
		return e->tex;
	}
	pixman_region32_fini(&todo);
	pixman_region32_init_rect(&todo, x1, y1, x2 - x1, y2 - y1);
	pixman_region32_subtract(&todo, &todo, &e->valid);
	if (!pixman_region32_not_empty(&todo)) {
		pixman_region32_fini(&todo);
		return e->tex;
	}

	GLint prev_fbo = 0;
	GLint prev_viewport[4];
	glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prev_fbo);
	glGetIntegerv(GL_VIEWPORT, prev_viewport);
	GLboolean stencil = glIsEnabled(GL_STENCIL_TEST);
	GLboolean blend = glIsEnabled(GL_BLEND);
	glDisable(GL_STENCIL_TEST);
	glDisable(GL_BLEND);

	glBindFramebuffer(GL_FRAMEBUFFER, e->fbo);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, e->tex, 0);
	bool ok = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
	if (ok) {
		struct glass_field_shader shader = renderer->shaders.glass_field;
		glViewport(0, 0, tw, th);
		glUseProgram(shader.program);
		glActiveTexture(GL_TEXTURE0);
		glBindTexture(mask->target, mask->tex);
		glTexParameteri(mask->target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(mask->target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		glUniform1i(shader.mask, 0);
		glUniform4f(shader.mask_src, mask_src[0], mask_src[1], mask_src[2], mask_src[3]);
		glUniform2f(shader.box_pos, pane->x, pane->y);
		glUniform2f(shader.box_size, pane->width, pane->height);
		glUniform1f(shader.edge, edge);
		glUniform2f(shader.field_span, field_span[0], field_span[1]);

		float proj[9];
		matrix_projection(proj, tw, th, WL_OUTPUT_TRANSFORM_FLIPPED_180);
		struct wlr_box box = { .x = 0, .y = 0, .width = tw, .height = th };
		struct wlr_fbox src = { .x = 0, .y = 0, .width = 1, .height = 1 };
		set_proj_matrix(shader.proj, proj, &box);
		set_tex_matrix(shader.tex_proj, WL_OUTPUT_TRANSFORM_NORMAL, &src);
		render(&box, &todo, shader.pos_attrib);
		glBindTexture(mask->target, 0);
		pixman_region32_union(&e->valid, &e->valid, &todo);
	} else {
		wlr_log(WLR_ERROR, "glass field target incomplete; shaped glass falls back to a box");
	}
	pixman_region32_fini(&todo);

	glBindFramebuffer(GL_FRAMEBUFFER, prev_fbo);
	glViewport(prev_viewport[0], prev_viewport[1], prev_viewport[2], prev_viewport[3]);
	if (stencil) {
		glEnable(GL_STENCIL_TEST);
	}
	if (blend) {
		glEnable(GL_BLEND);
	}
	return ok ? e->tex : 0;
}

// swayctl: draw the blurred backdrop as liquid glass inside `pane`
static void render_glass(struct fx_gles_render_pass *pass, struct fx_texture *texture,
		struct fx_render_texture_options *tex_options, const struct wlr_box *pane,
		const struct fx_glass_options *glass, struct fx_texture *mask, const struct wlr_fbox *mask_box,
		struct fx_glass_field_state *field_state) {
	struct wlr_render_texture_options *options = &tex_options->base;
	struct fx_renderer *renderer = pass->buffer->renderer;
	struct glass_shader shader = renderer->shaders.glass;

	struct wlr_box dst_box;
	wlr_render_texture_options_get_dst_box(options, &dst_box);
	struct wlr_fbox src_fbox = { .x = 0, .y = 0, .width = 1, .height = 1 };

	push_fx_debug(renderer);
	float glass_edge = glass->edge > 0 ? glass->edge : 18.0f;
	float field_span[2] = { 1.0f, 1.0f };
	GLuint field_tex = 0;
	if (mask) {
		float m[4] = { 0, 0, 1, 1 };
		if (mask_box && mask_box->width > 0 && mask_box->height > 0
				&& mask->wlr_texture.width > 0 && mask->wlr_texture.height > 0) {
			m[0] = mask_box->x / mask->wlr_texture.width;
			m[1] = mask_box->y / mask->wlr_texture.height;
			m[2] = mask_box->width / mask->wlr_texture.width;
			m[3] = mask_box->height / mask->wlr_texture.height;
		}
		field_tex = render_glass_field(renderer, field_state, pane, options->clip, glass_edge,
			mask, m, field_span);
		if (!field_tex) {
			mask = NULL;
		}

	}
	setup_blending(WLR_RENDER_BLEND_MODE_PREMULTIPLIED);
	glUseProgram(shader.program);
	glActiveTexture(GL_TEXTURE0);
	glBindTexture(texture->target, texture->tex);
	glTexParameteri(texture->target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
	glTexParameteri(texture->target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
	glUniform1i(shader.tex, 0);

	float radius = tex_options->corners.top_left;
	glUniform2f(shader.tex_size, texture->wlr_texture.width, texture->wlr_texture.height);
	glUniform2f(shader.box_pos, pane->x, pane->y);
	glUniform2f(shader.box_size, pane->width, pane->height);
	glUniform1f(shader.radius, radius);
	glUniform1f(shader.edge, glass_edge);
	glUniform1f(shader.thickness, glass->thickness);
	glUniform1f(shader.refraction, glass->refraction);
	glUniform1f(shader.chroma, glass->chroma);
	glUniform1f(shader.highlight, glass->highlight);
	glUniform1i(shader.text_mode, glass->text);
	glUniform1f(shader.alpha, options->alpha ? *options->alpha : 1.0f);
	glUniform1i(shader.use_mask, mask != NULL);
	glUniform1i(shader.mask, 1);
	// Only part of the mask's texture may be on screen (a window drawn by the
	// client with invisible resize margins around it: its source box); the
	// shape must come from that part, stretched over the pane, not the whole.
	float mx = 0, my = 0, mw = 1, mh = 1;
	if (mask && mask_box && mask_box->width > 0 && mask_box->height > 0
			&& mask->wlr_texture.width > 0 && mask->wlr_texture.height > 0) {
		mx = mask_box->x / mask->wlr_texture.width;
		my = mask_box->y / mask->wlr_texture.height;
		mw = mask_box->width / mask->wlr_texture.width;
		mh = mask_box->height / mask->wlr_texture.height;
	}
	glUniform4f(shader.mask_src, mx, my, mw, mh);
	if (mask) {
		glActiveTexture(GL_TEXTURE1);
		glBindTexture(mask->target, mask->tex);
		glTexParameteri(mask->target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(mask->target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		glActiveTexture(GL_TEXTURE2);
		glBindTexture(GL_TEXTURE_2D, field_tex);
		glActiveTexture(GL_TEXTURE0);
	}
	glUniform1i(shader.field, 2);
	glUniform2f(shader.field_span, field_span[0], field_span[1]);

	set_proj_matrix(shader.proj, pass->projection_matrix, &dst_box);
	set_tex_matrix(shader.tex_proj, options->transform, &src_fbox);
	render(&dst_box, options->clip, shader.pos_attrib);

	glBindTexture(texture->target, 0);
	if (mask) {
		glActiveTexture(GL_TEXTURE1);
		glBindTexture(mask->target, 0);
		glActiveTexture(GL_TEXTURE2);
		glBindTexture(GL_TEXTURE_2D, 0);
		glActiveTexture(GL_TEXTURE0);
	}
	pop_fx_debug(renderer);
}

void fx_render_pass_add_blur(struct fx_gles_render_pass *pass,
		struct fx_render_blur_pass_options *fx_options) {
	if (pass->fx_offscreen_buffers == NULL) {
		wlr_log(WLR_ERROR, "FX Pass offscreen buffers not initialized. Skipping blur...");
		return;
	}

	struct fx_renderer *renderer = pass->buffer->renderer;
	struct fx_render_texture_options *tex_options = &fx_options->tex_options;

	TRACY_BOTH_ZONES_START(renderer);
	push_fx_debug(renderer);

	const bool has_strength = fx_options->blur_strength < 1.0;
	struct fx_framebuffer *buffer = pass->fx_offscreen_buffers->optimized_blur_buffer;
	TRACY_ZONE_TEXT_f("Use Optimized Blur: %d", fx_options->use_optimized_blur);
	TRACY_ZONE_TEXT_f("Optimized Blur Successfully Used: %d",
			buffer && fx_options->use_optimized_blur);
	if (!fx_options->use_optimized_blur || has_strength) {
		// Render the blur into its own buffer
		struct fx_render_blur_pass_options blur_options = *fx_options;
		if (fx_options->use_optimized_blur && has_strength) {
			// Re-blur the saved non-blurred version of the optimized blur.
			// Isn't as efficient as just using the optimized blur buffer
			blur_options.current_buffer = pass->fx_offscreen_buffers->optimized_no_blur_buffer;
		} else {
			blur_options.current_buffer = pass->buffer;
		}
		buffer = get_main_buffer_blur(pass, &blur_options);
	}
	const struct fx_glass_options *g = &fx_options->glass;
	bool glass_on = g->refraction > 0 || g->chroma > 0 || g->highlight > 0;
	struct fx_glass_cache_entry *cache = fx_options->glass_cache;
	if (!buffer && glass_on && cache != NULL && cache->fb != NULL) {
		// swayctl: the kept backdrop (fx_glass_cache): bring in just what
		// changed under the pane (redrawn this frame up to here, so it holds
		// only what's below the pane), then bend the copy - no backdrop re-read
		// around what the window itself redrew
		if (!pixman_region32_empty(&cache->refresh)) {
			fx_render_pass_read_to_buffer(pass, &cache->refresh, cache->fb, pass->buffer);
			pixman_region32_clear(&cache->refresh);
		}
		cache->valid = true;
		buffer = cache->fb;
	}
	if (!buffer && glass_on && pass->fx_offscreen_buffers->effects_buffer) {
		// swayctl: clear glass (no blur): refract an untouched copy of what's
		// behind. With the demo IOR (2.45) the field pulls up to ~2.5x
		// `refraction` px at the rim (plus dispersion and the anti-stair-step
		// smear): copy that margin so the bend never reads stale pixels.
		struct fx_framebuffer *copy = pass->fx_offscreen_buffers->effects_buffer;
		pixman_region32_t region;
		pixman_region32_init(&region);
		pixman_region32_copy(&region, fx_options->tex_options.base.clip);
		float reach = g->refraction * 2.5f + g->refraction * 0.20f * (g->chroma > 0.0f ? 1.0f : 0.0f)
			+ 12.0f;
		wlr_region_expand(&region, &region, (int)ceilf(reach));
		pixman_region32_intersect_rect(&region, &region, 0, 0,
			pass->buffer->buffer->width, pass->buffer->buffer->height);
		fx_render_pass_read_to_buffer(pass, &region, copy, pass->buffer);
		pixman_region32_fini(&region);
		buffer = copy;
	}
	if (!buffer) {
		goto finish;
	}
	if (g->text == 3) {
		pass->ink_backdrop = buffer;
		pass->ink_box = fx_options->tex_options.base.dst_box;
	}
	if (fx_options->probe && fx_options->probe->want) {
		backdrop_probe_grab(fx_options->probe, renderer, buffer,
			&fx_options->tex_options.base.dst_box, fx_options->tex_options.base.clip);
	}
	struct wlr_texture *wlr_texture =
		fx_texture_from_buffer(&renderer->wlr_renderer, buffer->buffer);
	struct fx_texture *blur_texture = fx_get_texture(wlr_texture);

	// swayctl: shaped glass: the surface's own texture is the shape. Only a
	// plain 2D texture covering the pane can be sampled that way; otherwise
	// the pane is treated as a rounded box like the others.
	const struct fx_glass_options *glass = &fx_options->glass;
	bool glass_draw = glass->refraction > 0 || glass->chroma > 0 || glass->highlight > 0 || glass->text;
	struct fx_texture *glass_mask = NULL;
	if (glass_draw && fx_options->ignore_transparent && fx_options->tex_options.base.texture
			&& fx_options->tex_options.base.transform == WL_OUTPUT_TRANSFORM_NORMAL) {
		struct fx_texture *t = fx_get_texture(fx_options->tex_options.base.texture);
		if (t->target == GL_TEXTURE_2D) {
			glass_mask = t;
		}
	}
	// the stencil only keeps the glass off the surface's transparent parts;
	// shaped glass already covers exactly the alpha it reads (and discards
	// the rest), so drawing the whole surface into a stencil first is a
	// second full pass over the window for nothing
	bool stencil = fx_options->ignore_transparent && fx_options->tex_options.base.texture
		&& !glass_mask;

	// Get a stencil of the window ignoring transparent regions
	if (stencil) {
		stencil_mask_init();

		struct fx_render_texture_options tex_options = fx_options->tex_options;
		tex_options.discard_transparent = true;
		tex_options.clipped_region = fx_options->clipped_region;
		fx_render_pass_add_texture(pass, &tex_options);

		stencil_mask_close(true);
	}

	// the pane (the layer's box) before dst_box becomes the whole buffer
	struct wlr_box pane_box = tex_options->base.dst_box;
	struct wlr_render_texture_options mask_src = tex_options->base;  // the surface, if masked

	// Draw the blurred texture
	tex_options->base.dst_box = (struct wlr_box) {
		.x = 0,
		.y = 0,
		.width = buffer->buffer->width,
		.height = buffer->buffer->height,
	};
	tex_options->base.src_box = (struct wlr_fbox) {
		.x = 0,
		.y = 0,
		.width = buffer->buffer->width,
		.height = buffer->buffer->height,
	};
	struct wlr_box pane = pane_box;
	tex_options->base.texture = &blur_texture->wlr_texture;
	// since we're capturing from the fbo, transform will always be normal
	tex_options->base.transform = WL_OUTPUT_TRANSFORM_NORMAL;
	tex_options->clipped_region = fx_options->clipped_region;
	if (glass_draw) {
		render_glass(pass, blur_texture, tex_options, &pane, glass, glass_mask, &mask_src.src_box,
			fx_options->field);
	} else {
		fx_render_pass_add_texture(pass, tex_options);
	}

	wlr_texture_destroy(&blur_texture->wlr_texture);

	// Finish stenciling
	if (stencil) {
		stencil_mask_fini();
	}

finish:
	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
}

bool fx_render_pass_add_optimized_blur(struct fx_gles_render_pass *pass,
		struct fx_render_blur_pass_options *fx_options) {
	if (pass->fx_offscreen_buffers == NULL) {
		wlr_log(WLR_ERROR, "FX Pass offscreen buffers not initialized. Skipping optimized blur...");
		return false;
	}
	struct fx_renderer *renderer = pass->buffer->renderer;
	struct wlr_box dst_box = fx_options->tex_options.base.dst_box;

	TRACY_BOTH_ZONES_START(renderer);
	TRACY_ZONE_TEXT_f("dst_box (WxH, X, Y): %dx%d, %d, %d",
			fx_options->tex_options.base.dst_box.width,
			fx_options->tex_options.base.dst_box.height,
			fx_options->tex_options.base.dst_box.x,
			fx_options->tex_options.base.dst_box.y);
	TRACY_ZONE_TEXT_f("clip_box (WxH, X, Y): %dx%d, %d, %d",
			fx_options->tex_options.clip_box->width,
			fx_options->tex_options.clip_box->height,
			fx_options->tex_options.clip_box->x,
			fx_options->tex_options.clip_box->y);
	TRACY_ZONE_TEXT_f("src_box (WxH, X, Y): %lfx%lf, %lf, %lf",
			fx_options->tex_options.base.src_box.width,
			fx_options->tex_options.base.src_box.height,
			fx_options->tex_options.base.src_box.x,
			fx_options->tex_options.base.src_box.y);
	TRACY_ZONE_TEXT_f("Ignore Transparent: %d", fx_options->ignore_transparent);
	TRACY_ZONE_TEXT_f("Discard Transparent: %d", fx_options->tex_options.discard_transparent);
	TRACY_ZONE_TEXT_f("Use Optimized Blur: %d", fx_options->use_optimized_blur);
	TRACY_ZONE_TEXT_f("Blur Options:");
	TRACY_ZONE_TEXT_f("\tNum Blur Passes: %d", fx_options->blur_data->num_passes);
	TRACY_ZONE_TEXT_f("\tBlur Radius: %f", fx_options->blur_data->radius);
	TRACY_ZONE_TEXT_f("\tBrightness: %f", fx_options->blur_data->brightness);
	TRACY_ZONE_TEXT_f("\tContrast: %f", fx_options->blur_data->contrast);
	TRACY_ZONE_TEXT_f("\tNoise: %f", fx_options->blur_data->noise);
	TRACY_ZONE_TEXT_f("\tSaturation: %f", fx_options->blur_data->saturation);
	push_fx_debug(renderer);

	pixman_region32_t clip;
	pixman_region32_init_rect(&clip,
			dst_box.x, dst_box.y, dst_box.width, dst_box.height);

	// Render the blur into its own buffer
	struct fx_render_blur_pass_options blur_options = *fx_options;
	blur_options.current_buffer = pass->buffer;
	blur_options.tex_options.base.clip = &clip;
	struct fx_framebuffer *fx_buffer = get_main_buffer_blur(pass, &blur_options);
	if (fx_buffer != NULL) {
		// Render the newly blurred content into the blur_buffer
		fx_render_pass_read_to_buffer(pass, &clip,
				pass->fx_offscreen_buffers->optimized_blur_buffer, fx_buffer);

		// Save the current scene pass state
		fx_render_pass_read_to_buffer(pass, &clip,
				pass->fx_offscreen_buffers->optimized_no_blur_buffer, pass->buffer);
	}

	pixman_region32_fini(&clip);

	pop_fx_debug(renderer);
	TRACY_BOTH_ZONES_END;
	return fx_buffer != NULL;
}

void fx_render_pass_read_to_buffer(struct fx_gles_render_pass *pass,
		pixman_region32_t *_region, struct fx_framebuffer *dst_buffer,
		struct fx_framebuffer *src_buffer) {
	if (!_region || !pixman_region32_not_empty(_region)) {
		return;
	}
	TRACY_BOTH_ZONES_START(pass->buffer->renderer);

	pixman_region32_t region;
	pixman_region32_init(&region);
	pixman_region32_copy(&region, _region);

	struct wlr_texture *src_tex =
		fx_texture_from_buffer(&pass->buffer->renderer->wlr_renderer, src_buffer->buffer);
	if (src_tex == NULL) {
		goto done;
	}

	// Draw onto the dst_buffer
	fx_framebuffer_bind(dst_buffer);
	wlr_render_pass_add_texture(&pass->base, &(struct wlr_render_texture_options) {
		.texture = src_tex,
		.clip = &region,
		.transform = WL_OUTPUT_TRANSFORM_NORMAL,
		.blend_mode = WLR_RENDER_BLEND_MODE_NONE,
		.dst_box = (struct wlr_box){
			.x = 0,
			.y = 0,
			.width = dst_buffer->buffer->width,
			.height = dst_buffer->buffer->height,
		},
		.src_box = (struct wlr_fbox){
			.x = 0,
			.y = 0,
			.width = src_buffer->buffer->width,
			.height = src_buffer->buffer->height,
		},
	});
	wlr_texture_destroy(src_tex);

	// Bind back to the main WLR buffer
	fx_framebuffer_bind(pass->buffer);

done:
	TRACY_BOTH_ZONES_END;

	pixman_region32_fini(&region);
}

static const char *reset_status_str(GLenum status) {
	switch (status) {
	case GL_GUILTY_CONTEXT_RESET_KHR:
		return "guilty";
	case GL_INNOCENT_CONTEXT_RESET_KHR:
		return "innocent";
	case GL_UNKNOWN_CONTEXT_RESET_KHR:
		return "unknown";
	default:
		return "<invalid>";
	}
}

struct fx_gles_render_pass *fx_begin_buffer_pass(struct fx_framebuffer *buffer,
		struct wlr_egl_context *prev_ctx, struct fx_render_timer *timer,
		struct wlr_drm_syncobj_timeline *signal_timeline, uint64_t signal_point) {
	struct fx_renderer *renderer = buffer->renderer;
	struct wlr_buffer *wlr_buffer = buffer->buffer;

	if (renderer->procs.glGetGraphicsResetStatusKHR) {
		GLenum status = renderer->procs.glGetGraphicsResetStatusKHR();
		if (status != GL_NO_ERROR) {
			wlr_log(WLR_ERROR, "GPU reset (%s)", reset_status_str(status));
			wl_signal_emit_mutable(&renderer->wlr_renderer.events.lost, NULL);
			return NULL;
		}
	}

	GLint fbo = fx_framebuffer_get_fbo(buffer);
	if (!fbo) {
		return NULL;
	}

	struct fx_gles_render_pass *pass = calloc(1, sizeof(*pass));
	if (pass == NULL) {
		return NULL;
	}

	wlr_render_pass_init(&pass->base, &render_pass_impl);
	wlr_buffer_lock(wlr_buffer);
	pass->buffer = buffer;
	pass->timer = timer;
	pass->prev_ctx = *prev_ctx;
	if (signal_timeline != NULL) {
		pass->signal_timeline = wlr_drm_syncobj_timeline_ref(signal_timeline);
		pass->signal_point = signal_point;
	}

	pass->fx_offscreen_buffers = NULL;
	pixman_region32_init(&pass->blur_padding_region);
	pass->has_blur = false;

	matrix_projection(pass->projection_matrix, wlr_buffer->width, wlr_buffer->height,
		WL_OUTPUT_TRANSFORM_FLIPPED_180);

	push_fx_debug(renderer);
	glBindFramebuffer(GL_FRAMEBUFFER, fbo);

	glViewport(0, 0, wlr_buffer->width, wlr_buffer->height);
	glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
	glDisable(GL_SCISSOR_TEST);

	pop_fx_debug(renderer);
	return pass;
}
