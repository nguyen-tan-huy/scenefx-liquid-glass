// swayctl: the shadow of what a surface actually draws, not of its box.
// A shaped window or popup (panes and pills inside a transparent surface, as the glass sees
// them) takes its outline from the surface's alpha; its shadow is that outline blurred. Here,
// for each pixel around it, the blur is done by sampling the alpha at points scattered like a
// gaussian around the pixel (a Rayleigh-distributed radius on a golden-angle spiral, turned a
// little differently at every pixel so what is left of the sampling is fine grain, not bands):
// no extra texture, nothing to keep between frames, and the shadow follows whatever the client
// draws. The shape itself is cut out, so a pane of glass has no shadow showing through it.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec4 v_color;

uniform sampler2D mask;
uniform vec4 mask_src;     // the part of the mask texture that is shown (x, y, w, h; 0..1)
uniform vec2 mask_pos;     // where the mask is drawn (output px)
uniform vec2 mask_size;
uniform float blur_sigma;  // px: standard deviation of the gaussian
uniform vec2 shift;        // px the shadow is moved from its shape (the offset setting)

// any alpha at all is the shape (same test as the glass)
float mask_at(vec2 px) {
	vec2 uv = (px - mask_pos) / mask_size;
	if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
		return 0.0;
	}
	return clamp(texture2D(mask, mask_src.xy + uv * mask_src.zw).a / 0.003, 0.0, 1.0);
}

void main() {
	vec2 px = gl_FragCoord.xy;
	float turn = fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))) * 6.2831853;
	const int N = 40;
	float sum = 0.0;
	for (int i = 0; i < N; i++) {
		float u = (float(i) + 0.5) / float(N);
		float r = blur_sigma * sqrt(-2.0 * log(1.0 - u * 0.992));
		float a = float(i) * 2.39996323 + turn;
		sum += mask_at(px - shift + r * vec2(cos(a), sin(a)));
	}
	float shadow = (sum / float(N)) * (1.0 - mask_at(px));
	// the scene hands the colour premultiplied (rgb * a, a): premultiplied out, scaled by the shape
	gl_FragColor = vec4(v_color.rgb * shadow, v_color.a * shadow);
}
