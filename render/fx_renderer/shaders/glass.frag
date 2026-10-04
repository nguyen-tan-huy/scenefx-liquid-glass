// Liquid glass — archisvaze/liquid-glass (winaviation liquid-glass-demo):
// the refraction profile, the colour split at the rim, and the one specular
// line along the edge. Everything else is the pane's CSS.
//
// Refraction (demo calculateRefractionProfile):
//  - convex squircle h(x) = (1-(1-x)^4)^(1/4), x = 0 rim … 1 flat;
//  - Snell, remaining path = h(x)*bezel + thickness → rim magnifies, centre clear;
//  - R/G/B use slightly different IOR; `chroma` (px) is the R↔B separation at the rim.
//
// Specular (demo generateSpecularMap): a ~2 px line just inside the outline,
// bright where the edge faces the key light (60°), and the same line carries
// the demo's saturation boost. Opacity follows `highlight`.
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
uniform float edge;        // bezel width, px (demo Bezel Width)
uniform float thickness;   // glass optical depth, px (demo Glass Thickness)
uniform float refraction;  // bend strength in px (demo Refraction Scale × field)
uniform float chroma;      // R↔B separation at the rim, px (refraction × fraction)
uniform float highlight;   // light/specular opacity 0..1 (demo Specular Opacity)
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

// Convex squircle (demo SurfaceEquations.convex_squircle). x: 0 rim, 1 flat.
float demo_h(float x) {
	float u = 1.0 - x;
	return pow(max(1.0 - u * u * u * u, 0.0), 0.25);
}

// Snell displacement along the inward normal (demo calculateRefractionProfile).
// positive = backdrop pulled toward the pane centre (convex magnify).
// The demo measures the slope with a forward difference from exactly x = 0
// (the squircle's slope is infinite there) — same sampling here, so the
// profile, and the pull that `refraction` scales, match the demo frame for
// frame. The slope is clamped where mediump would square past its range.
float demo_disp(float x, float bezel_px, float thick_px, float ior) {
	float xs = clamp(x, 0.0, 1.0);
	float eps = xs < 1.0 ? 0.0001 : -0.0001;
	float y = demo_h(xs);
	float y2 = demo_h(clamp(xs + eps, 0.0, 1.0));
	float deriv = (y2 - y) / eps;
	deriv = clamp(deriv, -250.0, 250.0);
	float mag = sqrt(deriv * deriv + 1.0);
	float nx = -deriv / mag;
	float ny = -1.0 / mag;
	float eta = 1.0 / ior;
	float d = ny;
	float k = 1.0 - eta * eta * (1.0 - d * d);
	if (k < 0.0) {
		return 0.0;
	}
	float ks = sqrt(k);
	float rx = -(eta * d + ks) * nx;
	float ry = eta - (eta * d + ks) * ny;
	// demo: remaining glass the ray still travels after the surface hit
	float remaining = y * bezel_px + thick_px;
	return rx * (remaining / max(abs(ry), 1e-4));
}

void main() {
	vec2 px = v_texcoord * tex_size;
	vec2 half_size = box_size * 0.5;
	vec2 p = px - (box_pos + half_size);
	// The demo's bezel is `edge` px wide, no widening for thick glass: the
	// thickness only feeds the Snell path length below.
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
		// Distance to the edge along 12 directions: step out, then bisect on
		// the mask's anti-aliased outline for a sub-pixel distance. The bend
		// is measured from the *nearest* outline point (the demo's map is
		// built from the distance to the outline too).
		bevel = max(edge, 16.0);
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
			if (mask_at(px + dir * s1) < 0.5) { hi = s1; }
			else if (mask_at(px + dir * s2) < 0.5) { lo = s1; hi = s2; }
			else if (mask_at(px + dir * s3) < 0.5) { lo = s2; hi = s3; }
			float dist = bevel;
			reached[i] = hi > 0.0;
			if (reached[i]) {
				any_edge = true;
				for (int j = 0; j < 7; j++) {
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
		// The directions that never reached an edge stay pinned at `bevel`;
		// a log-average of all 12 would let them bury the near one — a pixel
		// on the rim itself has to read x≈0, not bevel/2.
		float dmin = bevel;
		for (int i = 0; i < 12; i++) {
			dmin = min(dmin, dists[i]);
		}
		// a thin pane (a pill) is thinner than two bevels: cap the bezel so the
		// middle line stays flat instead of tearing. Only a pair that reached
		// *both* outlines says how thick the pane is — the far side past the
		// probes' reach means "thicker than bevel", not "exactly 2×bevel".
		float thick = 1e4;
		for (int i = 0; i < 6; i++) {
			if (reached[i] && reached[i + 6]) {
				thick = min(thick, dists[i] + dists[i + 6]);
			}
		}
		bevel = max(min(bevel, thick * 0.5), 4.0);
		if (!any_edge) {
			n = vec2(0.0);
			d = -bevel;
		} else {
			vec2 nv = nsum / max(wsum, 1e-5);
			pull = smoothstep(0.02, 0.25, length(nv));
			n = nv / max(length(nv), 1e-5);
			d = -min(dmin, bevel);
		}
		// `a` is the pane's alpha over the ~1/255 floor: 1 wherever the pane
		// is drawn (its 6 % tint saturates it), fading across the anti-aliased
		// outline — glass covers the shape and fades with it.
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
		coverage = clamp(0.5 - d, 0.0, 1.0);
		float half_min = min(half_size.x, half_size.y);
		bevel = clamp(max(edge, half_min * 0.35), 1.0, max(half_min, 1.0));
	}

	// position across the bezel: 0 at the rim, 1 where the flat top begins
	float x = clamp(-d / bevel, 0.0, 1.0);
	float depth = -d;   // px from the rim

	// --- refraction (demo displacement field) ---
	// remaining path = h(x)*bezel + thickness; `refraction` (px) is the rim pull.
	// `chroma` (px) is the R↔B separation at the rim; 0 = one bend for all.
	// IOR is the demo's Refractive Index slider (2.45), R/B ±0.05 for dispersion.
	float ior_g = 2.45;
	float ior_r = 2.40;
	float ior_b = 2.50;
	float denom = max(thickness * 1.05 + bevel * 0.35, 1.0);
	float raw = demo_disp(x, bevel, thickness, ior_g);
	float raw_r = demo_disp(x, bevel, thickness, ior_r);
	float raw_b = demo_disp(x, bevel, thickness, ior_b);
	float field = raw / denom;
	float field_r = raw_r / denom;
	float field_b = raw_b / denom;
	float g_amt = field * refraction * pull;
	float span = max(field_b - field_r, 1e-4);
	float r_amt = g_amt - chroma * pull * (field - field_r) / span;
	float b_amt = g_amt + chroma * pull * (field_b - field) / span;
	vec2 base = px - n * g_amt;
	vec2 base_r = px - n * r_amt;
	vec2 base_b = px - n * b_amt;
	// light smear along the bend so steep gradients don't stair-step: the pull
	// is ~2x `refraction` px at the rim now, so a fixed share of it would blur
	// the whole bezel — keep the smear at about the pull per pixel instead.
	float spread = 0.35 + 0.06 * abs(g_amt);
	vec3 col_g = 0.5 * (texel_bilinear(base - n * spread * 0.5)
		+ texel_bilinear(base + n * spread * 0.5));
	vec3 col_r = texel_bilinear(base_r);
	vec3 col_b = texel_bilinear(base_b);
	vec3 color = vec3(col_r.r, col_g.g, col_b.b);

	// Keep the text readable (WCAG 4.5:1 against the text's own color): only
	// where the backdrop is too close to it, and only as much as needed.
	if (text_mode != 0) {
		vec3 lin = pow(max(color, vec3(0.0)), vec3(2.2));
		float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
		if (text_mode == 1) {
			float target = 0.18;
			if (lum > target) {
				color *= pow(target / lum, 1.0 / 2.2);
			}
		} else {
			float target = 0.25;
			if (lum < target) {
				float t = (target - lum) / max(1.0 - lum, 1e-3);
				color = mix(color, vec3(1.0), pow(t, 1.0 / 2.2));
			}
		}
	}

	// --- demo specular (archisvaze generateSpecularMap) ---
	// A ~2 px line just inside the outline. `coeff` = how square the edge faces
	// the key light (60°, y down) times the line's own falloff. The demo then
	// saturates what's behind on that same line (feColorMatrix saturate 3,
	// composited with the map's alpha) and lays its specular over it: grey
	// `coeff` at alpha coeff² × `highlight`.
	float band_x = 1.0 - depth;                 // 1 at the rim, -1 two px in
	float band = depth <= 2.0 ? sqrt(max(1.0 - band_x * band_x, 0.0)) : 0.0;
	float coeff = abs(dot(n, vec2(0.5, -0.866))) * band;
	if (coeff > 0.0) {
		vec3 grey = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
		color = mix(color, mix(grey, color, 3.0), coeff * coeff);
		color = mix(color, vec3(coeff), coeff * coeff * highlight);
	}

	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
