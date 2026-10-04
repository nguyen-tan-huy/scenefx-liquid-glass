#ifndef TYPES_FX_GLASS_H
#define TYPES_FX_GLASS_H

/** swayctl: liquid glass over a blurred pane; off when all are 0 */
struct fx_glass_options {
	float refraction; // overall bend strength (scales rim + body), px
	float edge;       // px width of the rim bevel
	float thickness;  // px body optical depth: whole-pane refraction (demo Glass Thickness)
	float chroma;     // px color split at the rim
	float highlight;  // 0..1 rim light
	int text;         // text drawn on the pane: 0 unknown, 1 light, 2 dark (keeps it readable)
};

#endif
