import * as THREE from 'three';

export interface ToonColors {
  lit: string;
  shade: string;
  deep: string;
  rim: string;
}

/**
 * 暗がりに沈める（森の大木のうろの中。入口から見える所はこの影に沈んで見える）：uDarken 0〜1 で、色にこの色を掛ける（青みの濃い影）。
 * uDarken は材質ごとに持つ（ゆっくりの部品だけに入れる：Yukkuri が体の下の部品の材質に配る）
 */
export const DARKEN_GLSL = /* glsl */ `
  uniform float uDarken;
  vec3 darken(vec3 col) {
    return col * mix(vec3(1.0), vec3(0.24, 0.23, 0.3), uDarken);
  }
`;

export const DEFAULT_SKIN: ToonColors = {
  lit: '#f6cfa3',
  shade: '#ecb98d',
  deep: '#d99e78',
  rim: '#fff1de',
};

const vertexShader = /* glsl */ `
  uniform float uBodyHeight;
  attribute vec3 aRest;
  varying vec3 vRest;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vHeight;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vHeight = position.y / uBodyHeight;
    vRest = aRest;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uLit;
  uniform vec3 uShade;
  uniform vec3 uDeep;
  uniform vec3 uRimColor;
  uniform vec3 uLightDir;
  uniform float uThreshold;
  uniform float uThreshold2;
  uniform float uSoftness;
  uniform float uRim;
  ${DARKEN_GLSL}
  uniform float uContactShade;
  // 焦げ（足焼き）：焦げの強さ 0〜1 と、焦げる高さ（静止形状の底から、高さに対する比）。静止形状の底と高さ
  uniform float uBurn;
  uniform float uBurnTop;
  uniform float uRestMinY;
  uniform float uRestH;
  uniform float uFace;
  // 顔：頭の中心から見た方向を、表面に沿った長さ（頭の半径単位）の顔座標にして絵を貼る
  uniform sampler2D uFaceTex;
  uniform vec3 uHeadC;     // 頭の中心（静止形状の座標）
  uniform float uHeadR;    // 頭の半径
  uniform vec4 uFaceRect;  // 絵の範囲 (xMin, yMin, xMax, yMax)
  varying vec3 vRest;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vHeight;

  void main() {
    vec3 n = normalize(vNormalW);
    float h = dot(n, normalize(uLightDir)) * 0.5 + 0.5;   // half-lambert

    // 3段のトゥーン階調（境界は少しだけぼかす）
    float tDeep = smoothstep(uThreshold2 - uSoftness, uThreshold2 + uSoftness, h);
    float tLit  = smoothstep(uThreshold  - uSoftness, uThreshold  + uSoftness, h);
    vec3 col = mix(uDeep, uShade, tDeep);
    col = mix(col, uLit, tLit);

    // 接地付近をわずかに暗く（重みの表現）
    col *= mix(1.0 - uContactShade, 1.0, smoothstep(0.0, 0.2, vHeight));

    // 足焼きの焦げ：底から uBurnTop までを、焼けるほどこんがり茶色から黒っぽく（静止形状の高さで決めるので、寝転んでも底に付いたまま）
    if (uBurn > 0.0) {
      float hr = (vRest.y - uRestMinY) / uRestH;
      float m = (1.0 - smoothstep(uBurnTop * 0.55, uBurnTop, hr)) * min(1.0, uBurn * 2.5);
      // 色は線形の値（こんがり茶色 #a8601f・黒っぽい焦げ #2c1509。sRGB の値をそのまま書くと明るすぎて肌と見分けがつかなかった）
      vec3 brown = vec3(0.39, 0.117, 0.014);
      vec3 charred = vec3(0.025, 0.0075, 0.003);
      vec3 burnt = mix(brown, charred, smoothstep(0.35, 1.0, uBurn) * (1.0 - smoothstep(0.0, uBurnTop, hr) * 0.5));
      col = mix(col, burnt * (0.75 + 0.25 * h), m);
    }

    // 縁を明るく（柔らかい皮の透け感）
    vec3 v = normalize(cameraPosition - vPosW);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    col = mix(col, uRimColor, rim * uRim);

    // 顔（静止形状の座標で貼るので、体の変形に合わせて歪む）。前方はローカル +Z
    if (uFace > 0.5) {
      vec3 d = vRest - uHeadC;
      float rxz = length(d.xz);
      float az = atan(d.x, d.z);
      float el = atan(d.y, rxz);
      vec2 f = vec2(az * rxz, el * length(d)) / uHeadR;
      vec2 uv = (f - uFaceRect.xy) / (uFaceRect.zw - uFaceRect.xy);
      vec4 t = texture2D(uFaceTex, uv);
      // 絵の範囲外と背中側には貼らない
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * step(abs(az), 1.6);
      col = col * (1.0 - t.a * inside) + t.rgb * inside;  // 乗算済みアルファ
    }

    gl_FragColor = vec4(darken(col), 1.0);
    #include <colorspace_fragment>
  }
`;

export function createToonMaterial(colors: ToonColors = DEFAULT_SKIN): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLit: { value: new THREE.Color(colors.lit) },
      uShade: { value: new THREE.Color(colors.shade) },
      uDeep: { value: new THREE.Color(colors.deep) },
      uRimColor: { value: new THREE.Color(colors.rim) },
      uLightDir: { value: new THREE.Vector3(-0.5, 0.9, 0.6).normalize() },
      uThreshold: { value: 0.62 },
      uThreshold2: { value: 0.32 },
      uSoftness: { value: 0.06 },
      uRim: { value: 0.18 },
      uContactShade: { value: 0.08 },
      uDarken: { value: 0 },
      uBurn: { value: 0 },
      uBurnTop: { value: 0.1 },
      uRestMinY: { value: -0.5 },
      uRestH: { value: 1 },
      uBodyHeight: { value: 1 },
      uFace: { value: 1 },
      uFaceTex: { value: null },
      uHeadC: { value: new THREE.Vector3() },
      uHeadR: { value: 0.3 },
      uFaceRect: { value: new THREE.Vector4(-1, -1, 1, 1) },
    },
    vertexShader,
    fragmentShader,
  });
}
