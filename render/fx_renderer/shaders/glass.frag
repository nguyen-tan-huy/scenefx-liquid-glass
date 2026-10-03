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
//  - glancing angles reflect more (Fresnel): the bevel brightens slightly.
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

// mean coverage of the mask around q out to r, 12 directions x 4 steps;
// each direction stops at the first step outside the pane, so a neighbouring
// pane across a narrow gap doesn't count as part of this one
float field(vec2 q, float r) {
	float sum = mask_at(q);
	for (int i = 0; i < 12; i++) {
		float a = float(i) * 0.523599;
		vec2 dir = vec2(cos(a), sin(a));
		float open = 1.0;
		for (int k = 1; k <= 4; k++) {
			float m = mask_at(q + dir * r * float(k) * 0.25) * open;
			sum += m;
			open = step(0.5, m);
		}
	}
	return sum / 49.0;
}

float rounded_box(vec2 p, vec2 half_size, float r) {
	vec2 q = abs(p) - half_size + r;
	return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 sample_rgb(vec2 px, vec2 shift) {
	vec2 uv = px / tex_size;
	vec2 s = shift / tex_size;
	return vec3(texture2D(tex, uv - s).r, texture2D(tex, uv).g, texture2D(tex, uv + s).b);
}

void main() {
	vec2 px = v_texcoord * tex_size;
	vec2 half_size = box_size * 0.5;
	vec2 p = px - (box_pos + half_size);
	float d;       // signed distance to the pane's edge, < 0 inside
	vec2 n;        // outward normal, in the plane
	float coverage;
	float bevel;
	if (use_mask) {
		float a = mask_at(px);
		if (a <= 0.0) {
			discard;
		}
		// A smooth coverage field (the mask averaged over two rings around the
		// point): 0.5 at the edge, rising to 1 a bevel's width inside. Its
		// level gives the position across the bevel and its slope the normal,
		// both continuous, so the bent backdrop has no jagged steps and every
		// pane gets the same rim whatever its size.
		bevel = max(edge * 1.4, 24.0);
		// cheap test first: a bevel's width all around inside = the flat
		// middle (most of a pane), nothing more to do there
		bool inside = true;
		for (int i = 0; i < 8 && inside; i++) {
			float a = float(i) * 0.785398;
			vec2 dir = vec2(cos(a), sin(a));
			// step out, so a gap to a neighbouring pane isn't jumped over
			// 8 px first (narrower than any gap between panes), then half way, then all
			if (mask_at(px + dir * 8.0) < 0.5 || mask_at(px + dir * bevel * 0.5) < 0.5
					|| mask_at(px + dir * bevel) < 0.5) {
				inside = false;
			}
		}
		float c = inside ? 1.0 : field(px, bevel);
		if (c > 0.999) {
			// deep inside (most of a big pane): flat, nothing to bend
			n = vec2(0.0);
			d = -bevel;
		} else {
			// direction to the edge from the field's slope (a wide step: smooth)
			float g = bevel * 0.5;
			vec2 grad = vec2(field(px + vec2(g, 0.0), bevel) - field(px - vec2(g, 0.0), bevel),
			                 field(px + vec2(0.0, g), bevel) - field(px - vec2(0.0, g), bevel));
			n = -grad / max(length(grad), 1e-5);
			// exact distance along it: step out to the edge, then bisect on the
			// mask's anti-aliased outline (sub-pixel, so no steps from row to row)
			float lo = 0.0, hi = bevel;
			for (int k = 1; k <= 8; k++) {
				float t = float(k) * bevel / 8.0;
				if (mask_at(px + n * t) < 0.5) {
					hi = t;
					lo = t - bevel / 8.0;
					break;
				}
			}
			for (int k = 0; k < 6; k++) {
				float mid = 0.5 * (lo + hi);
				if (mask_at(px + n * mid) < 0.5) { hi = mid; } else { lo = mid; }
			}
			d = -0.5 * (lo + hi);
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
	float shift = tan(bent) * refraction * (1.0 + 0.4 * u * u);

	// What's behind is seen sharp, only bent by the bevel (no smear): the
	// glass shows itself by how light passes through it, below.
	float rim = 1.0 - x;
	vec3 color = sample_rgb(px - n * shift, n * chroma * 0.3 * rim * rim);

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
	float rimline = exp(-depth * 1.4);                        // ~1 px
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

	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
