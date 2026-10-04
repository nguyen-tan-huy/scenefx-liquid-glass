// Liquid glass (swayctl patch), modelled on a thick pane with rounded edges:
//
//  - the pane's surface is flat in the middle and curves down over a bevel
//    of width `edge` at the rim (a quarter circle in profile);
//  - light through it bends by Snell's law (glass ~1.5) using that surface's
//    normal, so the backdrop is magnified and pulled inward near the rim and
//    untouched in the middle; red/green/blue bend a little differently
//    (dispersion), strongest at the very edge;
//  - no smear: light through the glass shows it instead (brighter, richer
//    color carried through the rim, a caustic band, a diagonal sheen);
//  - the rim catches a key light from the top left and a weaker one from the
//    opposite side (light bouncing inside the glass), as two thin bright lines;
//  - glancing angles reflect more (Fresnel): the bevel brightens slightly;
//  - polished gloss on top of that lighting: a crisp white core on the rim,
//    a lamp reflection on the face where it turns toward the light, and a thin
//    polished streak along that direction (all follow `highlight`).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_texcoord;
uniform sampler2D tex;

uniform vec2 tex_size;     // backdrop size in px
uniform vec2 box_pos;      // pane, in the same px space
uniform vec2 box_size;
uniform float radius;      // corner radius, px
uniform float edge;        // bevel width, px
uniform float refraction;  // pane thickness: how far the bevel can shift the backdrop, px
uniform float chroma;      // dispersion at the rim, px
uniform float highlight;   // rim light, 0..1
// The text drawn on this pane: 0 unknown, 1 light, 2 dark. Where what's behind
// the glass is too close to it in brightness, the glass darkens (light text)
// or lightens (dark text) just enough to keep the text readable.
uniform int text_mode;
uniform float alpha;
// Shaped panes (notification cards inside a big transparent surface): the
// surface's own alpha, drawn into a full-size buffer, gives the shape; the
// rim is found by looking for its edge instead of using a rounded box.
uniform bool use_mask;
uniform sampler2D mask;
uniform vec4 mask_src;     // the part of the mask texture that is shown (x, y, w, h; 0..1)

// The shape is where the surface isn't fully transparent: a glass card's own
// fill can be only a few percent opaque, so any alpha counts (smoothed over
// the anti-aliased outline), not how much. `mask` is the surface's own
// texture, covering the pane's box.
float mask_at(vec2 px) {
	vec2 uv = (px - box_pos) / box_size;
	if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
		return 0.0;
	}
	// any alpha at all (1/255 included: a nearly clear pane is stored as 1-3/255)
	return clamp(texture2D(mask, mask_src.xy + uv * mask_src.zw).a / 0.003, 0.0, 1.0);
}

float rounded_box(vec2 p, vec2 half_size, float r) {
	vec2 q = abs(p) - half_size + r;
	return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// The backdrop can come filtered NEAREST (its texture's own setting wins on
// some drivers): blend the four texels around `px` ourselves, so a shifted,
// non-integer position reads smoothly instead of snapping (stair steps).
vec3 texel_bilinear(vec2 px) {
	vec2 q = px - 0.5;
	vec2 f = fract(q);
	vec2 b = (floor(q) + 0.5) / tex_size;
	vec2 o = 1.0 / tex_size;
	vec3 c00 = texture2D(tex, b).rgb;
	vec3 c10 = texture2D(tex, b + vec2(o.x, 0.0)).rgb;
	vec3 c01 = texture2D(tex, b + vec2(0.0, o.y)).rgb;
	vec3 c11 = texture2D(tex, b + o).rgb;
	return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

vec3 sample_rgb(vec2 px, vec2 shift) {
	// color split only where there is one (the rim); elsewhere one lookup
	if (dot(shift, shift) < 0.0025) {
		return texel_bilinear(px);
	}
	return vec3(texel_bilinear(px - shift).r, texel_bilinear(px).g, texel_bilinear(px + shift).b);
}

void main() {
	vec2 px = v_texcoord * tex_size;
	vec2 half_size = box_size * 0.5;
	vec2 p = px - (box_pos + half_size);
	float d;       // signed distance to the pane's edge, < 0 inside
	float pull = 1.0;  // how clearly one edge is nearest (0 midway between two)
	vec2 n;        // outward normal, in the plane
	float coverage;
	float bevel;
	if (use_mask) {
		float a = mask_at(px);
		if (a <= 0.0) {
			discard;
		}
		// Distance to the edge along 8 directions: step out (8 px first, so a
		// narrow gap to a neighbouring pane is never jumped), then bisect on
		// the mask's anti-aliased outline for a sub-pixel distance. A soft
		// minimum of the 8 gives the depth, their weighted directions the
		// normal: smooth (no stripes), and cheap - the flat middle of a pane
		// costs 24 reads, a rim pixel at most ~64.
		bevel = max(edge * 1.4, 24.0);
		float k = 3.0 / bevel;   // soft: the normal turns smoothly round curves
		float wsum = 0.0;
		vec2 nsum = vec2(0.0);
		bool any_edge = false;
		float dists[12];
		for (int i = 0; i < 12; i++) {
			float ang = float(i) * 0.523599;
			vec2 dir = vec2(cos(ang), sin(ang));
			float s1 = 8.0, s2 = bevel * 0.5, s3 = bevel;
			float lo = 0.0, hi = -1.0;
			if (mask_at(px + dir * s1) < 0.5) { hi = s1; }
			else if (mask_at(px + dir * s2) < 0.5) { lo = s1; hi = s2; }
			else if (mask_at(px + dir * s3) < 0.5) { lo = s2; hi = s3; }
			float dist = bevel;
			if (hi > 0.0) {
				any_edge = true;
				for (int j = 0; j < 7; j++) {   // ~0.1 px: no stair steps in the depth
					float mid = 0.5 * (lo + hi);
					if (mask_at(px + dir * mid) < 0.5) { hi = mid; } else { lo = mid; }
				}
				dist = 0.5 * (lo + hi);
			}
			dists[i] = dist;
			float w = exp(-k * dist);
			wsum += w;
			nsum += dir * w;
		}
		// a thin pane (a pill) is thinner than two bevels: the bevel may be at
		// most half its thickness here, so its middle line stays flat instead
		// of tearing (top half pushed up, bottom half down)
		float thick = 2.0 * bevel;
		for (int i = 0; i < 6; i++) {
			thick = min(thick, dists[i] + dists[i + 6]);
		}
		float soft_k = k;
		bevel = max(min(bevel, thick * 0.5), 4.0);
		if (!any_edge) {
			n = vec2(0.0);   // the flat middle
			d = -bevel;
		} else {
			// opposite edges (the middle of a thin pill) cancel out: bend less
			// there instead of flipping direction from pixel to pixel
			vec2 nv = nsum / max(wsum, 1e-5);
			pull = smoothstep(0.02, 0.25, length(nv));
			n = nv / max(length(nv), 1e-5);
			d = -clamp(-log(wsum / 12.0) / soft_k, 0.0, bevel);  // soft minimum
		}
		coverage = a;
	} else {
		float r = min(radius, min(half_size.x, half_size.y));
		d = rounded_box(p, half_size, r);
		if (d > 0.5) {
			discard;
		}
		n = vec2(rounded_box(p + vec2(1.0, 0.0), half_size, r) - rounded_box(p - vec2(1.0, 0.0), half_size, r),
		         rounded_box(p + vec2(0.0, 1.0), half_size, r) - rounded_box(p - vec2(0.0, 1.0), half_size, r));
		n = n / max(length(n), 1e-4);
		coverage = clamp(0.5 - d, 0.0, 1.0);  // anti-aliased outline
		// deeper on a big pane: up to 40% of the way to the middle
		float half_min = min(half_size.x, half_size.y);
		bevel = clamp(max(edge, half_min * 0.4), 1.0, max(half_min, 1.0));
	}

	// position across the bevel: 0 at the rim, 1 where the flat top begins
	float x = clamp(-d / bevel, 0.0, 1.0);
	// quarter-circle profile h(x) = sqrt(1 - (1 - x)^2); its slope is the tilt
	float u = 1.0 - x;
	float slope = u / max(sqrt(1.0 - u * u), 0.08);       // dh/dx, steep at the rim
	float tilt = atan(slope);                            // surface angle from flat
	// Snell, air -> glass (n = 1.5): how far the ray leans inside the pane
	float bent = tilt - asin(sin(tilt) / 1.5);
	// macOS-like lens: the backdrop is pulled in hard right at the rim (a
	// convex edge magnifies), the flat middle stays put
	float shift = tan(bent) * refraction * (1.0 + 0.4 * u * u) * pull;

	// What's behind is seen sharp, only bent by the bevel (no smear): the
	// glass shows itself by how light passes through it, below.
	float rim = 1.0 - x;
	// two taps a little apart along the bend: where the shift changes fast
	// (near the rim) one sample per pixel shows stair steps
	vec2 disp = n * chroma * 0.3 * rim * rim;
	// The lens squeezes a wider strip of the backdrop into the rim: one sample
	// per pixel would skip over it (stair steps on lines). Four taps spread
	// along the squeeze, wider toward the rim, filter it.
	float spread = (0.5 + refraction * 0.12 * rim * rim) * pull;
	vec2 base = px - n * shift;
	vec3 color = 0.5 * (sample_rgb(base - n * spread * 0.5, disp) + sample_rgb(base + n * spread * 0.5, disp));

	// vibrancy: what's seen through the glass a touch brighter and more vivid
	vec3 grey = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
	color = mix(grey, color, 1.12) * (1.0 + 0.04 * highlight);

	// Keep the text readable (WCAG 4.5:1 against the text's own color): only
	// where the backdrop is too close to it, and only as much as needed.
	if (text_mode != 0) {
		vec3 lin = pow(max(color, vec3(0.0)), vec3(2.2));
		float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
		if (text_mode == 1) {
			// light text (~0.91): the backdrop may be at most ~0.18
			float target = 0.18;
			if (lum > target) {
				color *= pow(target / lum, 1.0 / 2.2);
			}
		} else {
			// dark text (~0.012): the backdrop must be at least ~0.25
			float target = 0.25;
			if (lum < target) {
				float t = (target - lum) / max(1.0 - lum, 1e-3);
				color = mix(color, vec3(1.0), pow(t, 1.0 / 2.2));
			}
		}
	}

	// Fresnel: the tilted bevel reflects a bit of the sky
	float fresnel = pow(1.0 - cos(tilt), 3.0);
	color = mix(color, vec3(1.0), 0.15 * fresnel * highlight);

	// Light through a thick, liquid-smooth pane (like clear glass or water
	// under a lamp): a crisp bright line right on the rim, a darker band just
	// inside it where the steep bevel reflects the dark surroundings instead
	// of letting light through, and a second thin reflection further in.
	// All follow the edge evenly; the light's direction only makes one side
	// a little brighter, so no corner turns into a bright blob.
	float depth = -d;                                         // px from the rim
	vec2 light = normalize(vec2(-0.6, -0.8));
	float lit = 0.55 + 0.45 * max(dot(n, light), 0.0);        // toward the light: brighter
	float rimline = exp(-depth * 1.0);                        // ~1-2 px, soft
	// glossy, not dark: a bright sheen along the inside of the rim, strongest
	// where the rim faces up toward the light (top), like polished glass
	float up = max(dot(n, vec2(0.0, -1.0)), 0.0);
	float gloss = exp(-pow((x - 0.22) / 0.14, 2.0)) * (0.35 + 0.65 * up);
	float inner = exp(-pow((x - 0.5) / 0.12, 2.0));           // soft inner reflection
	color = mix(color, vec3(1.0), 0.32 * gloss * highlight);
	color += highlight * (0.9 * rimline * lit + 0.08 * inner * lit);
	// depth: the lower inside edge a little darker, as a thick pane casts on itself
	float low = max(dot(n, vec2(0.0, 1.0)), 0.0);
	color *= 1.0 - 0.03 * low * rim * rim;

	// faint sheen across the top third, like light on the curved front
	float top = clamp(1.0 - (p.y + half_size.y) / max(box_size.y * 0.35, 1.0), 0.0, 1.0);
	if (!use_mask) {  // a shaped surface's box isn't the pane's: no sheen there
		color += highlight * 0.05 * top * top;
	}

	// Polished glass (gloss on top of the lighting above, same `highlight`):
	// a crisp white core right on the rim; light bounced up the underside of
	// the bevel (the lamp sits above the pane); and, on a rounded-box pane
	// (p is meaningful there, not on a shaped surface), an elliptical lamp
	// reflection upper-left plus a thin polished streak along the light.
	float core = exp(-depth * 3.5);                           // ~0.3 px white edge
	color += highlight * 0.28 * core * lit;
	float bounce_up = exp(-pow((x - 0.18) / 0.12, 2.0)) * low;
	color = mix(color, vec3(1.0), 0.14 * bounce_up * highlight);
	if (!use_mask) {
		vec2 s = p / max(box_size, vec2(1.0));               // -0.5..0.5 across the pane
		float spot = exp(-pow((s.x + 0.20) / 0.26, 2.0) - pow((s.y + 0.26) / 0.14, 2.0));
		color = mix(color, vec3(1.0), 0.20 * spot * highlight);
		vec2 rel = s - vec2(-0.20, -0.26);
		float across = rel.x * light.y - rel.y * light.x;    // distance from the light line
		float along = dot(rel, light);
		float streak = exp(-pow(across / 0.055, 2.0)) * exp(-pow((along - 0.18) / 0.32, 2.0));
		color += highlight * 0.07 * streak;
	}

	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
