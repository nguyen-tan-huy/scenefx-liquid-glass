// Liquid glass (swayctl patch), modelled on a thick pane with rounded edges:
//
//  - the pane's surface is flat in the middle and curves down over a bevel
//    of width `edge` at the rim (a quarter circle in profile);
//  - light through it bends by Snell's law (glass ~1.5) using that surface's
//    normal, so the backdrop is magnified and pulled inward near the rim and
//    untouched in the middle; red/green/blue bend a little differently
//    (dispersion), strongest at the very edge;
//  - the curved rim also smears what's behind it (more toward the edge), as a
//    thick pane does, instead of showing a sharp shifted copy;
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
uniform float alpha;
// Shaped panes (notification cards inside a big transparent surface): the
// surface's own alpha, drawn into a full-size buffer, gives the shape; the
// rim is found by looking for its edge instead of using a rounded box.
uniform bool use_mask;
uniform sampler2D mask;

// The shape is where the surface isn't fully transparent: a glass card's own
// fill can be only a few percent opaque, so any alpha counts (smoothed over
// the anti-aliased outline), not how much. `mask` is the surface's own
// texture, covering the pane's box.
float mask_at(vec2 px) {
	vec2 uv = (px - box_pos) / box_size;
	if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
		return 0.0;
	}
	return clamp(texture2D(mask, uv).a / 0.01, 0.0, 1.0);
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
		// march 16 directions out to the bevel width; the nearest edge gives
		// the distance, all edges within reach (weighted) give the normal
		bevel = max(edge, 4.0);
		float nearest = bevel;
		vec2 dir_sum = vec2(0.0);
		for (int i = 0; i < 16; i++) {
			float ang = float(i) * 0.392699;  // 2 pi / 16
			vec2 dir = vec2(cos(ang), sin(ang));
			for (int k = 1; k <= 12; k++) {
				float dist = float(k) * bevel / 12.0;
				if (mask_at(px + dir * dist) < 0.5) {
					nearest = min(nearest, dist);
					dir_sum += dir * (bevel - dist);
					break;
				}
			}
		}
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
		bevel = max(min(edge, min(half_size.x, half_size.y)), 1.0);
	}

	// position across the bevel: 0 at the rim, 1 where the flat top begins
	float x = clamp(-d / bevel, 0.0, 1.0);
	// quarter-circle profile h(x) = sqrt(1 - (1 - x)^2); its slope is the tilt
	float u = 1.0 - x;
	float slope = u / max(sqrt(1.0 - u * u), 0.08);       // dh/dx, steep at the rim
	float tilt = atan(slope);                            // surface angle from flat
	// Snell, air -> glass (n = 1.5): how far the ray leans inside the pane
	float bent = tilt - asin(sin(tilt) / 1.5);
	float shift = tan(bent) * refraction;                // px across the pane's thickness

	// What's seen through the curved rim is smeared, not just moved: a thick
	// curved pane scatters the light, more the steeper it is. Gather a small
	// ellipse of samples (long along the normal, the direction the bevel bends
	// light) that grows toward the rim; on the flat top it shrinks to one point.
	float rim = 1.0 - x;
	float smear = refraction * 0.45 * rim * rim + 1.5 * rim;
	vec2 base = px - n * shift;
	vec2 disp = n * chroma * 0.6 * rim * rim;
	vec3 color;
	if (smear < 0.75) {
		color = sample_rgb(base, disp);
	} else {
		vec2 t = vec2(-n.y, n.x);
		vec3 acc = vec3(0.0);
		float wsum = 0.0;
		for (int i = 0; i < 12; i++) {
			float r = sqrt((float(i) + 0.5) / 12.0);
			float a = float(i) * 2.39996;                     // golden angle: even spread
			vec2 off = (n * cos(a) * 1.7 + t * sin(a) * 0.6) * r * smear;
			float w = 1.0 - 0.55 * r;                         // denser in the middle
			acc += sample_rgb(base + off, disp) * w;
			wsum += w;
		}
		color = acc / wsum;
	}

	// Fresnel: the tilted bevel reflects a bit of the sky
	float fresnel = pow(1.0 - cos(tilt), 3.0);
	color = mix(color, vec3(1.0), 0.35 * fresnel * highlight);

	// rim lights: key from the top left, weaker bounce from the bottom right,
	// as thin lines riding the outermost pixels of the bevel
	vec2 light = normalize(vec2(-0.55, -0.85));
	float key = pow(max(dot(n, light), 0.0), 1.5);
	float bounce = pow(max(dot(n, -light), 0.0), 2.0) * 0.45;
	float line = 0.7 * exp(-(-d) * 0.6) + 0.35 * exp(-(-d) * 0.2);   // soft line + glow
	color += highlight * line * (key + bounce);
	// faint sheen across the top third, like light on the curved front
	float top = clamp(1.0 - (p.y + half_size.y) / max(box_size.y * 0.35, 1.0), 0.0, 1.0);
	if (!use_mask) {  // a shaped surface's box isn't the pane's: no sheen there
		color += highlight * 0.05 * top * top;
	}

	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
