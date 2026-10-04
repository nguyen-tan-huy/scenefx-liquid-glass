// Liquid glass — port of kube.io / winaviation liquid-glass-demo
// (https://winaviation.github.io/liquid-glass-demo/, based on kube.io
// "Liquid Glass in the Browser" + Apple WWDC 2025).
//
// Model:
//  - the pane is flat inside the bezel and curves over a convex squircle
//    profile h(x) = (1-(1-x)^4)^(1/4), x = 0 at the rim … 1 at the flat top;
//  - a ray hits that surface, refracts by Snell (glass n = 1.5), then travels
//    through the remaining glass: path = h(x)*bezel + thickness. The backdrop
//    is sampled along that bent ray — a real magnifying bezel, not a painted
//    highlight. Thickness only lengthens the path, so it strengthens the rim
//    bend; the flat centre stays clear (rx = 0 there);
//  - red/green/blue use slightly different IOR (dispersion), so high-contrast
//    edges behind the rim split into colour fringes (demo "Refraction Scale"
//    snap);
//  - specular is a thin bright band on the very edge, strongest toward a key
//    light from the upper-left (demo Specular Highlight map), plus a soft
//    Fresnel wash on the tilted bevel;
//  - optional light frost (glass_blur) and tint (glass_opacity / milk) sit on
//    top of the refracted colour; text_mode keeps UI text readable.
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
uniform float chroma;      // dispersion 0..1 (colour split at the rim)
uniform float highlight;   // specular opacity 0..1 (demo Specular Opacity)
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
// Returns a signed-ish magnitude in glass units; caller applies direction.
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
		// the mask's anti-aliased outline for a sub-pixel distance.
		bevel = max(edge, 16.0);
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
		// a thin pane (a pill) is thinner than two bezels: cap the bezel so the
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
		bevel = clamp(max(edge, half_min * 0.35), 1.0, max(half_min, 1.0));
	}

	// position across the bezel: 0 at the rim, 1 where the flat top begins
	float x = clamp(-d / bevel, 0.0, 1.0);
	float depth = -d;   // px from the rim

	// --- refraction (demo displacement field) ---
	// glass units: remaining path = h(x)*bezel + thickness. Normalise so
	// `refraction` (px) is the rim pull at the current thickness — same role
	// as demo's maximumDisplacement * refractionScale.
	// `chroma` arrives in px (compositor sends refraction * fraction): it is
	// the R↔B separation at the rim; 0 = all channels share one bend.
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
	// (demo feColorMatrix saturate ~1.3 on the displaced image)
	vec3 grey = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
	color = mix(grey, color, 1.18) * (1.0 + 0.04 * highlight);

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

	// --- specular (demo calculateSpecularHighlight) ---
	// thin band on the very edge; brightest where the rim faces the key light
	vec2 light = normalize(vec2(-0.6, -0.8));
	float lit = 0.45 + 0.55 * max(dot(n, light), 0.0);
	// demo specularThickness ≈ 1.5 px on a 200 px capsule → scale with bevel
	float spec_w = max(bevel * 0.04, 1.2);
	float edge_ratio = clamp(depth / spec_w, 0.0, 1.0);
	float sharp = sqrt(max(0.0, 1.0 - (1.0 - edge_ratio) * (1.0 - edge_ratio)));
	// also light the tilted face a little (Fresnel), like glancing glass
	float fresnel = pow(clamp(depth / max(bevel, 1.0), 0.0, 1.0), 2.0)
		* pow(1.0 - abs(n.y) * 0.15, 2.0);
	float spec = highlight * (0.70 * sharp * lit + 0.22 * fresnel * lit);
	color = mix(color, vec3(1.0), clamp(spec, 0.0, 1.0));
	// crisp white core right on the outline
	color += highlight * 0.35 * exp(-depth * 3.5) * lit;

	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
