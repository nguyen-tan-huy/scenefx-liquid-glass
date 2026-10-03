// Liquid glass (swayctl patch): the blurred backdrop seen through a rounded
// pane of glass. Near the pane's edge the backdrop is refracted inward (a
// lens), the color channels split slightly (dispersion), and the rim catches
// a light from the top left. Deeper inside it's the plain blur.
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
uniform float edge;        // width of the refracting rim, px
uniform float refraction;  // how far the rim pulls the backdrop, px
uniform float chroma;      // dispersion at the rim, px
uniform float highlight;   // rim light, 0..1
uniform float alpha;

float rounded_box(vec2 p, vec2 half_size, float r) {
	vec2 q = abs(p) - half_size + r;
	return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
	vec2 px = v_texcoord * tex_size;
	vec2 half_size = box_size * 0.5;
	vec2 p = px - (box_pos + half_size);
	float r = min(radius, min(half_size.x, half_size.y));
	float d = rounded_box(p, half_size, r);  // < 0 inside
	if (d > 0.5) {
		discard;
	}
	// outward normal from the distance field's gradient
	vec2 n = vec2(rounded_box(p + vec2(1.0, 0.0), half_size, r) - rounded_box(p - vec2(1.0, 0.0), half_size, r),
	              rounded_box(p + vec2(0.0, 1.0), half_size, r) - rounded_box(p - vec2(0.0, 1.0), half_size, r));
	n = n / max(length(n), 1e-4);

	// 1 at the very edge, 0 once `edge` px inside; squared so the bend is steep
	// at the rim and fades smoothly, like the curved side of a thick pane
	float rim = 1.0 - clamp(-d / max(edge, 1.0), 0.0, 1.0);
	float bend = rim * rim;

	vec2 uv = (px - n * bend * refraction) / tex_size;
	vec2 split = n * bend * chroma / tex_size;
	vec3 color = vec3(texture2D(tex, uv - split).r, texture2D(tex, uv).g, texture2D(tex, uv + split).b);

	// rim light: brightest where the edge faces the light (top left)
	float facing = max(dot(n, normalize(vec2(-0.55, -0.85))), 0.0);
	float thin_rim = 1.0 - clamp(-d / 1.5, 0.0, 1.0);
	color += highlight * (0.55 * facing * bend + 0.35 * thin_rim);
	// a soft sheen over the top of the pane
	color += highlight * 0.06 * clamp(1.0 - (p.y + half_size.y) / max(box_size.y, 1.0) * 2.0, 0.0, 1.0);

	// anti-aliased outline
	float coverage = clamp(0.5 - d, 0.0, 1.0);
	gl_FragColor = vec4(min(color, 1.0), 1.0) * coverage * alpha;
}
