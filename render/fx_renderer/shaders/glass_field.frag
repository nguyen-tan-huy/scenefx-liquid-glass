// swayctl: the shape field of a shaped liquid glass pane, for glass.frag.
// A shaped pane (a window or layer that draws only its widgets) takes its
// outline from the surface's alpha; finding how far a pixel is from that
// outline means searching the mask in 12 directions — dozens of reads. Done
// here once per field texel (a fraction of the screen's pixels) instead of
// for every pixel of the pane: the field is smooth, so glass.frag reads it
// back bilinearly in one fetch (Core Animation keeps its glass shapes as
// geometry for the same reason, never as a per-pixel search).
//
// Out (RGBA8): rg = averaged outline direction (outward, length = how clearly
// one edge is nearest) * 0.5 + 0.5; b = position across the bezel (0 rim …
// 1 flat top); a = the bezel width used here, 4 px … max(edge, 16) px.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_texcoord;

uniform vec2 box_pos;      // pane, in the backdrop's px space
uniform vec2 box_size;
uniform float edge;        // bezel width, px
uniform sampler2D mask;
uniform vec4 mask_src;     // the part of the mask texture that is shown (x, y, w, h; 0..1)
uniform vec2 field_span;   // px of the pane the whole field texture covers

// same test as glass.frag: any alpha at all is the pane
float mask_at(vec2 px) {
	vec2 uv = (px - box_pos) / box_size;
	if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
		return 0.0;
	}
	return clamp(texture2D(mask, mask_src.xy + uv * mask_src.zw).a / 0.003, 0.0, 1.0);
}

void main() {
	vec2 px = box_pos + v_texcoord * field_span;
	// Texels just outside the outline are found too (searching for where the
	// pane starts instead of ends): the rim pixels read them bilinearly
	// together with the inside ones, so they must carry the same normal.
	bool inside = mask_at(px) >= 0.5;
	float bmax = max(edge, 16.0);
	float bevel = bmax;
	float k = 3.0 / bevel;
	float wsum = 0.0;
	vec2 nsum = vec2(0.0);
	bool any_edge = false;
	float dists[12];
	bool reached[12];
	for (int i = 0; i < 12; i++) {
		float ang = float(i) * 0.523599;
		vec2 dir = vec2(cos(ang), sin(ang));
		float s1 = 8.0, s2 = bevel * 0.5, s3 = bevel;
		float lo = 0.0, hi = -1.0;
		if ((mask_at(px + dir * s1) >= 0.5) != inside) { hi = s1; }
		else if ((mask_at(px + dir * s2) >= 0.5) != inside) { lo = s1; hi = s2; }
		else if ((mask_at(px + dir * s3) >= 0.5) != inside) { lo = s2; hi = s3; }
		float dist = bevel;
		reached[i] = hi > 0.0;
		if (reached[i]) {
			any_edge = true;
			for (int j = 0; j < 7; j++) {
				float mid = 0.5 * (lo + hi);
				if ((mask_at(px + dir * mid) >= 0.5) != inside) { hi = mid; } else { lo = mid; }
			}
			dist = 0.5 * (lo + hi);
		}
		dists[i] = dist;
		float w = exp(-k * dist);
		wsum += w;
		nsum += dir * w;
	}
	float dmin = bevel;
	for (int i = 0; i < 12; i++) {
		dmin = min(dmin, dists[i]);
	}
	// a thin pane (a pill) is thinner than two bevels: cap the bezel so the
	// middle line stays flat (see glass.frag's history for why only pairs
	// that reached both outlines count)
	if (inside) {
		float thick = 1e4;
		for (int i = 0; i < 6; i++) {
			if (reached[i] && reached[i + 6]) {
				thick = min(thick, dists[i] + dists[i + 6]);
			}
		}
		bevel = max(min(bevel, thick * 0.5), 4.0);
	}
	vec2 nv = vec2(0.0);
	float x = 1.0;
	if (any_edge) {
		nv = nsum / max(wsum, 1e-5);
		if (!inside) {
			nv = -nv;  // the outline is behind us: outward is away from it
		}
		x = inside ? clamp(min(dmin, bevel) / bevel, 0.0, 1.0) : 0.0;
	}
	// Only a texel whose whole 4x4 px cell is plainly inside, with no
	// outline within 8 px, can stand in for its pixels; anything else
	// (speckled faint halos, slivers, edges) is marked unreliable (x = 0)
	// and glass.frag searches those pixels itself.
	if (inside) {
		bool mixed = any_edge && dmin < 8.0;
		for (int i = 0; i < 4; i++) {
			vec2 c = vec2(i == 0 || i == 2 ? -2.0 : 2.0, i < 2 ? -2.0 : 2.0);
			mixed = mixed || mask_at(px + c) < 0.5 || mask_at(px + c * 0.5) < 0.5;
		}
		if (mixed) {
			x = 0.0;
		}
	}
	float b = bmax > 4.0 ? (bevel - 4.0) / (bmax - 4.0) : 0.0;
	gl_FragColor = vec4(clamp(nv * 0.5 + 0.5, 0.0, 1.0), x, clamp(b, 0.0, 1.0));
}
