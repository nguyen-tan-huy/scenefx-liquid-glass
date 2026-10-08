#define SOURCE %d
#define EFFECTS %d

#define SOURCE_TEXTURE_RGBA 1
#define SOURCE_TEXTURE_RGBX 2
#define SOURCE_TEXTURE_EXTERNAL 3

#if !defined(SOURCE) || !defined(EFFECTS)
#error "Missing shader preamble"
#endif

#if SOURCE == SOURCE_TEXTURE_EXTERNAL
#extension GL_OES_EGL_image_external : require
#endif

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_texcoord;

#if SOURCE == SOURCE_TEXTURE_EXTERNAL
uniform samplerExternalOES tex;
#elif SOURCE == SOURCE_TEXTURE_RGBA || SOURCE == SOURCE_TEXTURE_RGBX
uniform sampler2D tex;
#endif

uniform float alpha;

#if EFFECTS
uniform vec2 size;
uniform vec2 position;
uniform float radius_top_left;
uniform float radius_top_right;
uniform float radius_bottom_left;
uniform float radius_bottom_right;

uniform vec2 clip_size;
uniform vec2 clip_position;
uniform float clip_radius_top_left;
uniform float clip_radius_top_right;
uniform float clip_radius_bottom_left;
uniform float clip_radius_bottom_right;
#endif

uniform bool discard_transparent;

#if SOURCE == SOURCE_TEXTURE_RGBA
// swayctl: key ink. A window over liquid glass (`glass text auto`) draws its
// text in one reserved colour, the key; here that text gets light or dark
// ink, whichever stands out on what's behind the glass at that spot (the
// kept backdrop, averaged over ~ink_reach px so a word gets one ink).
uniform bool ink;
uniform sampler2D ink_backdrop;
uniform vec2 ink_size;    // px of the backdrop (the frame being drawn)
uniform float ink_reach;  // px radius the backdrop is averaged over

const vec3 INK_KEY = vec3(1.0, 0.0, 254.0 / 255.0);  // #FF00FE
const vec3 INK_LIGHT = vec3(0.97);
const vec3 INK_DARK = vec3(0.07, 0.07, 0.09);

float ink_lum(vec3 c) {
	return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec4 apply_ink(vec4 c) {
	if (!ink || c.a < 0.004) {
		return c;
	}
	vec3 rgb = c.rgb / c.a;
	// text is drawn over nothing or over the pane's faint white body: its
	// colour lies between white and the key, `t` of the way (its coverage)
	vec3 d = INK_KEY - vec3(1.0);
	float t = clamp(dot(rgb - vec3(1.0), d) / dot(d, d), 0.0, 1.0);
	if (t < 0.03 || length(rgb - (vec3(1.0) + t * d)) > 0.09) {
		return c;
	}
	// an opaque pixel that isn't (nearly) the key itself is a picture's
	// pink, not text
	if (c.a > 0.985 && t < 0.92) {
		return c;
	}
	if (ink_size.x <= 0.0) {
		return vec4(clamp(rgb + t * (INK_LIGHT - INK_KEY), 0.0, 1.0) * c.a, c.a);
	}
	vec2 uv = gl_FragCoord.xy / ink_size;
	vec2 r = vec2(ink_reach) / ink_size;
	vec3 b = texture2D(ink_backdrop, uv).rgb * 0.2;
	b += texture2D(ink_backdrop, uv + vec2(r.x, 0.0)).rgb * 0.1;
	b += texture2D(ink_backdrop, uv - vec2(r.x, 0.0)).rgb * 0.1;
	b += texture2D(ink_backdrop, uv + vec2(0.0, r.y)).rgb * 0.1;
	b += texture2D(ink_backdrop, uv - vec2(0.0, r.y)).rgb * 0.1;
	b += texture2D(ink_backdrop, uv + r * 0.7).rgb * 0.1;
	b += texture2D(ink_backdrop, uv - r * 0.7).rgb * 0.1;
	b += texture2D(ink_backdrop, uv + vec2(r.x, -r.y) * 0.7).rgb * 0.1;
	b += texture2D(ink_backdrop, uv + vec2(-r.x, r.y) * 0.7).rgb * 0.1;
	// sRGB-ish values: a bright backdrop (> ~0.55) takes dark ink
	// a narrow band: ink is light or dark, not a grey that matches the backdrop
	float dark = smoothstep(0.53, 0.57, ink_lum(b));
	vec3 col = mix(INK_LIGHT, INK_DARK, dark);
	rgb = clamp(rgb + t * (col - INK_KEY), 0.0, 1.0);
	return vec4(rgb * c.a, c.a);
}
#endif

vec4 sample_texture() {
#if SOURCE == SOURCE_TEXTURE_RGBA
	return apply_ink(texture2D(tex, v_texcoord));
#elif SOURCE == SOURCE_TEXTURE_EXTERNAL
	return texture2D(tex, v_texcoord);
#elif SOURCE == SOURCE_TEXTURE_RGBX
	return vec4(texture2D(tex, v_texcoord).rgb, 1.0);
#endif
}

#if EFFECTS
float corner_alpha(vec2 size, vec2 position, bool is_cutout,
		float radius_tl, float radius_tr, float radius_bl, float radius_br);
#endif

void main() {
#if EFFECTS
	float quad_corner_alpha = corner_alpha(
		size - 0.5,
		position + 0.25,
		false,
		radius_top_left,
		radius_top_right,
		radius_bottom_left,
		radius_bottom_right
	);

	// Clipping
	float clip_corner_alpha = corner_alpha(
		clip_size - 1.0,
		clip_position + 0.5,
		true,
		clip_radius_top_left,
		clip_radius_top_right,
		clip_radius_bottom_left,
		clip_radius_bottom_right
	);

	gl_FragColor = sample_texture() * alpha * quad_corner_alpha * clip_corner_alpha;
#else
	gl_FragColor = sample_texture() * alpha;
#endif

	if (discard_transparent && gl_FragColor.a == 0.0) {
		discard;
	}
}
