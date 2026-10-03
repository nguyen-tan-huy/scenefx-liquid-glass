#ifndef TYPES_FX_GLASS_H
#define TYPES_FX_GLASS_H

/** swayctl: refraction at the edge of a blurred pane; off when all are 0 */
struct fx_glass_options {
	float refraction; // px the rim pulls the backdrop in
	float edge;       // px width of the rim
	float chroma;     // px color split at the rim
	float highlight;  // 0..1 rim light
};

#endif
