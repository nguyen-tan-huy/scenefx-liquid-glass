// swayctl: shrink what is behind a pane of glass before it's read back for
// a backdrop probe (fx/glass.h): each output texel is the mean of a
// sub x sub block (sub = 2, 4 or 8), sampled as 2x2 bilinear taps. The CPU
// only ever looks at ~8x8 samples per grid cell, so the full-size readback
// (15 MB for a big window, a 6-16 ms stall of the render loop) bought
// nothing but a dropped frame.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_texcoord;
uniform sampler2D tex;
uniform vec2 tex_size;   // the backdrop, px
uniform vec2 origin;     // backdrop px of output texel (0, 0)'s block
uniform vec2 out_span;   // the output target's size, texels
uniform float sub;

void main() {
	vec2 base = origin + floor(v_texcoord * out_span) * sub;
	vec3 acc = vec3(0.0);
	float n = 0.0;
	for (int j = 0; j < 4; j++) {
		for (int i = 0; i < 4; i++) {
			if (float(i) * 2.0 < sub && float(j) * 2.0 < sub) {
				// halfway between two texels: one bilinear read is their mean
				acc += texture2D(tex, (base + vec2(float(i), float(j)) * 2.0 + 1.0) / tex_size).rgb;
				n += 1.0;
			}
		}
	}
	gl_FragColor = vec4(acc / n, 1.0);
}
