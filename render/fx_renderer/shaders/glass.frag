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
// the pane's shape field (glass_field.frag): rg normal, b bezel position, a bezel
uniform sampler2D shape_field;
uniform vec2 field_span;   // px of the pane the whole field texture covers

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

// Distance to the shaped pane's outline along 12 directions: step out, then
// bisect on the mask's anti-aliased outline for a sub-pixel distance. The
// bend is measured from the *nearest* outline point (the demo's map is built
// from the distance to the outline too). The same search glass_field.frag
// caches at 1/4 resolution; run here only right next to the outline.
// swayctl: a bezel wider than the pane's corners would meet itself across
// them on a diagonal crease (two edges, each bending on its own: a pane in
// pieces). Where two edges at least 90 deg apart are both within the bezel,
// take the distance a corner rounded at the bezel's own width would give -
// the demo's geometry when bezel = radius - which joins the straight edges
// continuously, so the rim can be wider than the corners and stay one piece.
void round_corners(float dists[12], float r, inout float d, inout vec2 n) {
	int ia = 0;
	for (int i = 1; i < 12; i++) {
		if (dists[i] < dists[ia]) { ia = i; }
	}
	float a = dists[ia];
	float b = 1e4;
	int ib = ia;
	for (int i = 0; i < 12; i++) {
		int dd = i - ia;
		if (dd < 0) { dd = -dd; }
		if (dd > 6) { dd = 12 - dd; }
		if (dd >= 3 && dists[i] < b) { b = dists[i]; ib = i; }
	}
	if (a < r && b < r) {
		vec2 ka = vec2(cos(float(ia) * 0.523599), sin(float(ia) * 0.523599));
		vec2 kb = vec2(cos(float(ib) * 0.523599), sin(float(ib) * 0.523599));
		vec2 q = vec2(r - a, r - b);
		d = r - length(q);
		vec2 nv = ka * q.x + kb * q.y;
		if (length(nv) > 1e-4) { n = normalize(nv); }
	} else {
		d = min(a, b);
	}
}

void search_outline(vec2 px, out vec2 n, out float d, out float pull, out float bevel) {
	bevel = max(edge, 16.0);
	pull = 1.0;
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
	float dmin = bevel;
	for (int i = 0; i < 12; i++) {
		dmin = min(dmin, dists[i]);
	}
	// a thin pane (a pill) is thinner than two bevels: cap the bezel so the
	// middle line stays flat; only a pair that reached both outlines says
	// how thick the pane is
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
		float dr = dmin;
		round_corners(dists, bevel, dr, n);
		d = -min(dr, bevel);
	}
}

// the surface's own alpha at `px`, as drawn (not saturated like mask_at)
float raw_alpha(vec2 px) {
	vec2 uv = (px - box_pos) / box_size;
	if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
		return 0.0;
	}
	return texture2D(mask, mask_src.xy + uv * mask_src.zw).a;
}

float rounded_box(vec2 p, vec2 half_size, float r) {
	vec2 q = abs(p) - half_size + r;
	return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// The backdrop is bound GL_LINEAR (render_glass sets it on the texture right
// before drawing), so one fetch is already bilinear: no hand-rolled 4-tap
// blend (4x the texture reads on every sample of the pane).
vec3 texel_bilinear(vec2 px) {
	return texture2D(tex, px / tex_size).rgb;
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
	float across = 1e4;  // the pane's thickness here, px (how far a bend may reach)
	float body = 1.0;    // how much of a pane's body this pixel is (bends scale with it)
	if (use_mask) {
		float a = mask_at(px);
		if (a <= 0.0) {
			discard;
		}
		// Near the outline (anything within ~6 px) the pane is searched here,
		// per pixel: the cached field (glass_field.frag) is 1/4 resolution,
		// and a sliver thinner than a couple of its texels (a faint shadow
		// or text halo, a hairline gap) reads it as a smear of rim pull.
		// Everywhere else — most of a pane — the field's one fetch stands in
		// for the 36+ reads of the search.
		bool near = false;
		for (int i = 0; i < 8; i++) {
			float ang = float(i) * 0.785398;
			vec2 dir = vec2(cos(ang), sin(ang));
			if (mask_at(px + dir * 3.0) < 0.5 || mask_at(px + dir * 6.0) < 0.5) {
				near = true;
				break;
			}
		}
		if (near) {
			search_outline(px, n, d, pull, bevel);
		} else {
			// the four field texels around this pixel, blended by hand: one
			// unreliable texel (x = 0, see glass_field.frag) means search
			vec2 fsize = field_span / 4.0;  // texels in the field texture
			vec2 q = (px - box_pos) / 4.0 - 0.5;
			vec2 fr = fract(q);
			vec2 t0 = (floor(q) + 0.5) / fsize;
			vec2 to = 1.0 / fsize;
			vec4 f00 = texture2D(shape_field, t0);
			vec4 f10 = texture2D(shape_field, t0 + vec2(to.x, 0.0));
			vec4 f01 = texture2D(shape_field, t0 + vec2(0.0, to.y));
			vec4 f11 = texture2D(shape_field, t0 + to);
			bool unsure = min(min(f00.b, f10.b), min(f01.b, f11.b)) < 0.5 / 255.0;
			vec4 f = mix(mix(f00, f10, fr.x), mix(f01, f11, fr.x), fr.y);
			vec2 nv = f.rg * 2.0 - 1.0;
			float bmax = max(edge, 16.0);
			bevel = bmax > 4.0 ? mix(4.0, bmax, f.a) : bmax;
			float len = length(nv);
			if (len < 0.01) {
				// no outline within reach: flat top (8-bit 0.5 is not exactly 0)
				n = vec2(0.0);
				d = -bevel;
			} else {
				pull = smoothstep(0.02, 0.25, len);
				n = nv / len;
				d = -f.b * bevel;
			}
			if (unsure) {
				d = 0.0;  // -> searched below
			}
			// The probes above found no outline within 6 px, so a field that
			// says otherwise is stale (a redraw the client's damage didn't
			// cover): work this pixel out directly instead of bending by it.
			if (-d < 7.0) {
				search_outline(px, n, d, pull, bevel);
			}
		}
		// `a` is the pane's alpha over the ~1/255 floor: 1 wherever the pane
		// is drawn (its 6 % tint saturates it), fading across the anti-aliased
		// outline — glass covers the shape and fades with it.
		coverage = a;
		// A pane's body is a few % opaque at least (ChoSua's tint ~10/255);
		// what's fainter - anti-aliased rims, text halos, a strip's wash -
		// still gets glass but no bend: bending it by a pane's full pull
		// dragged red wallpaper into ragged streaks outside the tabs.
		body = smoothstep(2.0 / 255.0, 6.0 / 255.0, raw_alpha(px));
		// the bezel only comes out narrower than asked where the pane is
		// thinner than two of them (search_outline / the field's cap): that
		// is where its thickness is known, ~2 bezels
		if (bevel < max(edge, 16.0) - 0.5) {
			across = 2.0 * bevel;
		}
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
		across = 2.0 * half_min;
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
	vec3 color;
	if (x >= 1.0) {
		// Flat interior: demo_disp(1) is exactly 0, so every channel bends by 0
		// wherever pull is finite — no Snell solve, and R = B = the unbent pixel.
		// G keeps the rim's anti-stair-step smear (it collapses to the pixel
		// itself where the normal is 0, i.e. inside a shaped pane).
		vec3 f = texel_bilinear(px);
		if (n.x == 0.0 && n.y == 0.0) {
			color = f;
		} else {
			vec2 off = n * 0.175;  // spread = 0.35 px at zero bend, half of it
			float g = 0.5 * (texel_bilinear(px - off).g + texel_bilinear(px + off).g);
			color = vec3(f.r, g, f.b);
		}
	} else {
		float denom = max(thickness * 1.05 + bevel * 0.35, 1.0);
		float raw = demo_disp(x, bevel, thickness, ior_g);
		float field = raw / denom;
		float g_amt = field * refraction * pull;
		// A thin pane (a tab, a bar pill, a one-line header) bends no further
		// than ~40 % of its own thickness: the demo's pull (up to ~2.5x
		// `refraction`, 700 px at the top setting on a 2x screen) dragged
		// whatever was far beyond such a pane across all of it - streaks.
		// Big panes keep the full lens. `fit` scales the colour split too.
		if (use_mask && abs(g_amt) > 4.0) {
			// shaped pane: how thick it is here isn't known past two bezels.
			// Measure it along both axes (the pane's height and width here),
			// never along the normal: that walk ran straight across at an
			// edge's middle and diagonally near a corner, so the bend's fit
			// jumped between the two - a strip with a seam at each corner.
			float walk = 2.5 * abs(g_amt);
			for (int ax = 0; ax < 2; ax++) {
				vec2 dir = ax == 0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
				float ext = 0.0;
				for (int sgn = 0; sgn < 2; sgn++) {
					vec2 sd = sgn == 0 ? dir : -dir;
					float e = walk;
					for (int i = 1; i <= 8; i++) {
						float t = walk * float(i) / 8.0;
						if (mask_at(px + sd * t) < 0.5) {
							e = t;
							break;
						}
					}
					ext += e;
				}
				across = min(across, ext);
			}
		}
		float reach = max(0.4 * across, 4.0);
		// Scale the whole profile to fit (by its pull at the rim), never clip
		// it pixel by pixel: a clip made the outer band one flat shift - a
		// copied strip with a seam, each edge its own, the pane read as four
		// pieces - where the demo's lens falls off smoothly from the rim.
		float rim_amt = abs(demo_disp(0.0, bevel, thickness, ior_g) / denom * refraction * pull);
		float fit = rim_amt > reach ? reach / rim_amt : 1.0;
		fit *= body;
		g_amt *= fit;
		// light smear along the bend so steep gradients don't stair-step: the pull
		// is ~2x `refraction` px at the rim now, so a fixed share of it would blur
		// the whole bezel — keep the smear at about the pull per pixel instead.
		float spread = 0.35 + 0.06 * abs(g_amt);
		vec2 base = px - n * g_amt;
		vec3 col_g = 0.5 * (texel_bilinear(base - n * spread * 0.5)
			+ texel_bilinear(base + n * spread * 0.5));
		vec3 col_r, col_b;
		if (chroma <= 0.0) {
			// chroma * pull * ... is exactly 0: both side channels share the
			// green bend, so one sample feeds R and B.
			col_r = texel_bilinear(base);
			col_b = col_r;
		} else {
			float field_r = demo_disp(x, bevel, thickness, ior_r) / denom;
			float field_b = demo_disp(x, bevel, thickness, ior_b) / denom;
			float span = max(field_b - field_r, 1e-4);
			col_r = texel_bilinear(px - n * (g_amt - fit * chroma * pull * (field - field_r) / span));
			col_b = texel_bilinear(px - n * (g_amt + fit * chroma * pull * (field_b - field) / span));
		}
		color = vec3(col_r.r, col_g.g, col_b.b);
	}

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
		} else if (text_mode == 2) {
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
	vec2 ln = n;
	if (use_mask && band > 0.0) {
		// On the line the light follows the outline itself: the slope of the
		// pane's anti-aliased alpha, which turns smoothly round any curve. The
		// searched normal (12 directions, blended) steps along a pill's ends
		// and split its light into segments.
		vec2 g = vec2(0.0);
		for (int i = 1; i <= 2; i++) {
			float r = float(i) * 1.5;
			g += vec2(raw_alpha(px + vec2(r, 0.0)) - raw_alpha(px - vec2(r, 0.0)),
			          raw_alpha(px + vec2(0.0, r)) - raw_alpha(px - vec2(0.0, r))) / r;
		}
		if (length(g) > 1e-4) {
			ln = -normalize(g);  // alpha falls going out: outward normal
		}
	}
	float coeff = abs(dot(ln, vec2(0.5, -0.866))) * band;
	if (coeff > 0.0) {
		vec3 grey = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
		color = mix(color, mix(grey, color, 3.0), coeff * coeff);
		color = mix(color, vec3(coeff), coeff * coeff * highlight);
	}

	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
