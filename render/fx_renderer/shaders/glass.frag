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
	return clamp(texture2D(mask, mask_src.xy + uv * mask_src.zw).a / 0.01, 0.0, 1.0);
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
		// The bevel grows with the pane: up to `reach` on a big pane, but never
		// more than about half the pane's local thickness, so a small pill
		// still has a flat top. March 8 axes both ways out to `reach`: the
		// nearest edge gives the distance, the thinnest axis the thickness,
		// all edges within reach (weighted) the normal.
		float reach = max(edge * 2.5, 48.0);
		float nearest = reach;
		float thickness = 2.0 * reach;
		vec2 dir_sum = vec2(0.0);
		// most of a big pane is far from any edge: one ring of probes says so
		bool interior = true;
		for (int i = 0; i < 8; i++) {
			float ang = float(i) * 0.785398;  // 2 pi / 8
			if (mask_at(px + vec2(cos(ang), sin(ang)) * reach) < 0.5) {
				interior = false;
				break;
			}
		}
		if (!interior) {
			for (int i = 0; i < 8; i++) {
				float ang = float(i) * 0.392699;  // pi / 8: 8 axes cover all 16 directions
				vec2 dir = vec2(cos(ang), sin(ang));
				float h1 = reach;
				float h2 = reach;
				// 24 steps, and the edge placed between the last inside and the
				// first outside step by the mask's (anti-aliased) value: smooth
				// distances, no blocky bands
				float prev1 = 1.0, prev2 = 1.0;
				for (int k = 1; k <= 24; k++) {
					float dist = float(k) * reach / 24.0;
					if (h1 == reach) {
						float m = mask_at(px + dir * dist);
						if (m < 0.5) {
							h1 = dist - reach / 24.0 * clamp((0.5 - m) / max(prev1 - m, 1e-3), 0.0, 1.0);
						}
						prev1 = m;
					}
					if (h2 == reach) {
						float m = mask_at(px - dir * dist);
						if (m < 0.5) {
							h2 = dist - reach / 24.0 * clamp((0.5 - m) / max(prev2 - m, 1e-3), 0.0, 1.0);
						}
						prev2 = m;
					}
				}
				nearest = min(nearest, min(h1, h2));
				thickness = min(thickness, h1 + h2);
				dir_sum += dir * (reach - h1) - dir * (reach - h2);
			}
		}
		bevel = max(min(reach, thickness * 0.45), 4.0);
		d = -nearest;
		n = dir_sum / max(length(dir_sum), 1e-4);
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
	float shift = tan(bent) * refraction * (1.0 + 1.2 * u * u);

	// What's behind is seen sharp, only bent by the bevel (no smear): the
	// glass shows itself by how light passes through it, below.
	float rim = 1.0 - x;
	vec3 color = sample_rgb(px - n * shift, n * chroma * 0.6 * rim * rim);

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
	color = mix(color, vec3(1.0), 0.35 * fresnel * highlight);

	// specular edge, as on macOS: a thin bright line along the rim, strongest
	// on the two corners the light rakes (top left, and its reflection at the
	// bottom right), fading along the other two sides
	vec2 light = normalize(vec2(-0.6, -0.8));
	float rake = abs(dot(n, light));                         // both lit sides
	float spec = pow(rake, 3.0);
	float line = exp(-(-d) * 1.1);                           // 1-2 px line
	float glow = exp(-(-d) * 0.25) * 0.25;                   // soft inner glow
	color += highlight * (line * (0.25 + 0.75 * spec) + glow * spec);
	// depth: the lower inside edge a little darker, as a thick pane casts on itself
	float low = max(dot(n, vec2(0.0, 1.0)), 0.0);
	color *= 1.0 - 0.08 * low * rim * rim;

	// faint sheen across the top third, like light on the curved front
	float top = clamp(1.0 - (p.y + half_size.y) / max(box_size.y * 0.35, 1.0), 0.0, 1.0);
	if (!use_mask) {  // a shaped surface's box isn't the pane's: no sheen there
		color += highlight * 0.05 * top * top;
	}

	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
