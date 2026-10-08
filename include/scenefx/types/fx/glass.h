#ifndef TYPES_FX_GLASS_H
#define TYPES_FX_GLASS_H

#include <pixman.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** swayctl: liquid glass over a blurred pane; off when all are 0 */
struct fx_glass_options {
	float refraction; // overall bend strength (scales rim + body), px
	float edge;       // px width of the rim bevel
	float thickness;  // px body optical depth: whole-pane refraction (demo Glass Thickness)
	float chroma;     // px color split at the rim
	float highlight;  // 0..1 rim light
	int text;         // text drawn on the pane: 0 unknown, 1 light, 2 dark (keeps it readable)
};

/**
 * swayctl: what is behind a pane of glass, grabbed while it is drawn (the
 * copy the glass refracts), so a client can pick text that stands out on it
 * without the pane itself (its own text) in the sample. The compositor sets
 * `want`; the next frame that draws the pane fills `rgb` and sets `ready`.
 */
struct fx_backdrop_probe {
	bool want;
	bool ready;
	int width, height;   // buffer px of `rgb` (the pane's box, clipped)
	unsigned char *rgb;  // width * height * 3, top-down
	size_t cap;
	// Only what a frame redraws is fresh in the copy the glass bends (a big
	// pane - a window - is redrawn in parts): each frame updates those parts
	// of `rgb`; `complete` once every pixel has been filled since a resize.
	bool complete;
	int x, y;            // buffer px of `rgb`'s top left (the pane's box)
	unsigned char *seen; // width * height: 1 = filled since the resize
	size_t seen_cap;
	size_t filled;       // how many of `seen` are 1
	int pending_asks;    // requests answered "not drawn yet" in a row
	int sub;             // buffer px per `rgb` px on each side (big panes are shrunk); 0 = 1
};

/**
 * swayctl: what a shaped pane's cached shape field (see glass_field.frag)
 * must redo. The field is kept between frames, like Core Animation keeps a
 * layer's shape: what changes behind the glass, or the window moving, never
 * recomputes it — only the parts of the surface that the client redrew.
 */
struct fx_glass_field_state {
	uint64_t id;             // never reused, so a freed node's field isn't taken for a new one's
	pixman_region32_t dirty; // mask buffer px redrawn since the field last saw them
	bool all_dirty;          // new buffer size and the like: redo it all
};

/**
 * swayctl: the clean backdrop under a pane of clear glass (no blur), kept
 * between frames: what is behind it before the pane and everything above it
 * is drawn, in output buffer px. The glass bends this copy instead of one
 * taken from the frame being drawn, so when only the window on the glass
 * changes (text typed, a hover, a new message) just what the client redrew
 * is redrawn: no backdrop re-read around it out to the bend's reach (~2.5x
 * `refraction`, hundreds of px) and nothing of the window's own last frame in
 * what the glass bends. The copy is refreshed only where what is *under* the
 * pane changed (`dirty`), and wholly when the pane moves, resizes or appears.
 */
#define FX_GLASS_CACHE_OUTPUTS 4

struct fx_framebuffer;

struct fx_glass_cache_entry {
	const void *output;          // the wlr_scene_output it is for; NULL = unused
	struct fx_framebuffer *fb;   // output-sized, the backdrop where `valid`
	pixman_region32_t dirty;     // buffer px whose backdrop changed since copied
	pixman_region32_t refresh;   // this frame: copy these from the frame into `fb`
	bool valid;                  // `fb` holds the pane's whole area (else: copy it all)
};

struct fx_glass_cache {
	struct fx_glass_cache_entry entries[FX_GLASS_CACHE_OUTPUTS];
};

/** swayctl: drop one output's copy (its framebuffer too) */
void fx_glass_cache_entry_release(struct fx_glass_cache_entry *entry);

#endif
