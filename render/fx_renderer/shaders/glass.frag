// Liquid glass — kube.io / winaviation liquid-glass-demo refraction +
// the swayctl light stack (rim light, gloss, Fresnel, lamp reflection).
//
// Refraction (demo):
//  - convex squircle h(x) = (1-(1-x)^4)^(1/4), x = 0 rim … 1 flat;
//  - Snell, remaining path = h(x)*bezel + thickness → rim magnifies, centre clear;
//  - R/G/B use slightly different IOR; `chroma` (px) is the R↔B separation at the rim.
//
// Light (swayctl, all follow `highlight`):
//  - Fresnel wash on the tilted bevel (glancing angles reflect more);
//  - crisp rimline + polished core on the outline;
//  - gloss sheen inside the rim, brighter toward the key light (upper-left);
//  - inner reflection band, bounce up the underside, soft top sheen;
//  - elliptical lamp reflection + polished streak (rounded-box panes only);
//  - mild Beer-Lambert at the steep rim so thick edges read as mass.
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

// Snell displacement along the inward normal (demo calculateDisplacementMap1D).
// positive = backdrop pulled toward the pane centre (convex magnify).
float demo_disp(float x, float bezel_px, float thick_px, float ior) {
	float xs = clamp(x, 0.0025, 1.0);
	float y = demo_h(xs);
	float eps = 0.002;
	float y2 = demo_h(clamp(xs + eps, 0.0, 1.0));
	float deriv = (y2 - y) / eps;
	// keep the rim finite: squircle slope → ∞ at x = 0
	deriv = clamp(deriv, -80.0, 80.0);
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

// Surface tilt from the squircle profile (for Fresnel / gloss orientation).
float demo_tilt(float x) {
	float xs = clamp(x, 0.0025, 1.0);
	float eps = 0.002;
	float deriv = (demo_h(clamp(xs + eps, 0.0, 1.0)) - demo_h(xs)) / eps;
	deriv = clamp(deriv, -80.0, 80.0);
	return atan(deriv);
}

void main() {
	vec2 px = v_texcoord * tex_size;
	vec2 half_size = box_size * 0.5;
	vec2 p = px - (box_pos + half_size);
	// Optical depth: thick panes get wider light bands (rim mass).
	float pane = clamp(thickness / 200.0, 0.0, 7.5);
	float rim_wide = 1.0 + 0.50 * min(pane, 3.5);   // 1.0 @0, 1.5 @200, 2.75 @1500
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
		// the mask's anti-aliased outline for a sub-pixel distance.
		bevel = max(edge * rim_wide, 16.0);
		float k = 3.0 / bevel;
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
		// a thin pane (a pill) is thinner than two bevels: cap the bezel so the
		// middle line stays flat instead of tearing
		float thick = 2.0 * bevel;
		for (int i = 0; i < 6; i++) {
			thick = min(thick, dists[i] + dists[i + 6]);
		}
		float soft_k = k;
		bevel = max(min(bevel, thick * 0.5), 4.0);
		if (!any_edge) {
			n = vec2(0.0);
			d = -bevel;
		} else {
			vec2 nv = nsum / max(wsum, 1e-5);
			pull = smoothstep(0.02, 0.25, length(nv));
			n = nv / max(length(nv), 1e-5);
			d = -clamp(-log(wsum / 12.0) / soft_k, 0.0, bevel);
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
		coverage = clamp(0.5 - d, 0.0, 1.0);
		float half_min = min(half_size.x, half_size.y);
		bevel = clamp(max(edge * rim_wide, half_min * 0.35), 1.0, max(half_min, 1.0));
	}

	// position across the bezel: 0 at the rim, 1 where the flat top begins
	float x = clamp(-d / bevel, 0.0, 1.0);
	float depth = -d;   // px from the rim
	float tilt = demo_tilt(x);
	float rim = 1.0 - x;

	// --- refraction (demo displacement field) ---
	// remaining path = h(x)*bezel + thickness; `refraction` (px) is the rim pull.
	// `chroma` (px) is the R↔B separation at the rim; 0 = one bend for all.
	float ior_g = 1.50;
	float ior_r = 1.475;
	float ior_b = 1.530;
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
	// light smear along the bend so steep gradients don't stair-step
	float spread = 0.35 + 0.12 * abs(g_amt);
	vec3 col_g = 0.5 * (texel_bilinear(base - n * spread * 0.5)
		+ texel_bilinear(base + n * spread * 0.5));
	vec3 col_r = texel_bilinear(base_r);
	vec3 col_b = texel_bilinear(base_b);
	vec3 color = vec3(col_r.r, col_g.g, col_b.b);

	// vibrancy: what's seen through the glass a touch brighter and more vivid
	vec3 grey = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
	color = mix(grey, color, 1.14) * (1.0 + 0.05 * highlight);

	// Thick glass absorbs along the longest path (the steep bevel): a green-grey
	// Beer-Lambert band so the edge reads as mass, not a hairline.
	float rim_abs = clamp(0.55 + 0.10 * min(pane, 2.5), 0.0, 0.72);
	color *= mix(vec3(1.0), vec3(0.62, 0.70, 0.68), clamp(rim_abs * rim * rim, 0.0, 0.70));

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

	// --- light stack (swayctl; all follow `highlight`) ---
	vec2 light = normalize(vec2(-0.6, -0.8));
	float lit = 0.55 + 0.45 * max(dot(n, light), 0.0);
	float up = max(dot(n, vec2(0.0, -1.0)), 0.0);
	float low = max(dot(n, vec2(0.0, 1.0)), 0.0);

	// Fresnel: the tilted bevel reflects the sky; thicker glass has more glancing surface
	float fresnel = pow(1.0 - cos(tilt), 3.0);
	color = mix(color, vec3(1.0), (0.42 + 0.10 * min(pane, 2.0)) * fresnel * highlight);

	// rimline + gloss + inner reflection (bands widen with optical depth)
	float rimline = exp(-depth * 0.85 / rim_wide);
	float gloss = exp(-pow((x - 0.22) / (0.14 * rim_wide), 2.0)) * (0.35 + 0.65 * up);
	float inner = exp(-pow((x - 0.5) / (0.12 * rim_wide), 2.0));
	color = mix(color, vec3(1.0), 0.40 * gloss * highlight);
	color += highlight * (1.15 * rimline * lit + 0.10 * inner * lit);

	// self-shadow: the lower inside edge a little darker (thick pane casts on itself)
	color *= 1.0 - (0.06 + 0.04 * min(pane, 2.0)) * low * rim * rim;

	// faint sheen across the top third, like light on the curved front
	if (!use_mask) {
		float top = clamp(1.0 - (p.y + half_size.y) / max(box_size.y * 0.35, 1.0), 0.0, 1.0);
		color += highlight * 0.07 * top * top;
	}

	// polished glass: crisp white core on the rim, bounce up the underside,
	// elliptical lamp reflection + streak (rounded-box panes only)
	float core = exp(-depth * 4.0 / rim_wide);
	color += highlight * 0.40 * core * lit;
	float bounce_up = exp(-pow((x - 0.18) / (0.12 * rim_wide), 2.0)) * low;
	color = mix(color, vec3(1.0), 0.20 * bounce_up * highlight);
	if (!use_mask) {
		vec2 s = p / max(box_size, vec2(1.0));               // -0.5..0.5 across the pane
		float spot = exp(-pow((s.x + 0.20) / 0.26, 2.0) - pow((s.y + 0.26) / 0.14, 2.0));
		color = mix(color, vec3(1.0), 0.24 * spot * highlight);
		vec2 rel = s - vec2(-0.20, -0.26);
		float across = rel.x * light.y - rel.y * light.x;    // distance from the light line
		float along = dot(rel, light);
		float streak = exp(-pow(across / 0.055, 2.0)) * exp(-pow((along - 0.18) / 0.32, 2.0));
		color += highlight * 0.09 * streak;
	}

	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
