#ifndef TYPES_FX_GLASS_H
#define TYPES_FX_GLASS_H

#include <stdbool.h>
#include <stddef.h>

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
};

#endif
