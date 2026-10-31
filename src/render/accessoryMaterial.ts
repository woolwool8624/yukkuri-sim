import * as THREE from 'three';
import { DARKEN_GLSL, type ToonColors } from './toonMaterial';
import { GROUND_ACCESSORY, GROUND_LAYER } from './ground';

/**
 * 装飾（帽子・リボン・三つ編みなど）のトゥーン塗り。体と同じ3段の階調で、
 * 光の向きと階調の境目は体の材質と共有する（調整パネルの変更がそのまま効く）。
 */
const vertexShader = /* glsl */ `
  uniform float uGround; // この高さ（ワールド）で止める
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    // 地面に押し付けられた所は平らにつぶれて上を向く。もとが上を向いていた面ほどわずかに高く置く
    // （表と裏が同じ高さに重なると、どちらが手前か決まらず縞やぎざぎざになった：おさげのリボン・帽子のリボン）
    if (wp.y < uGround) {
      wp.y = uGround + ${GROUND_LAYER.toFixed(5)} * (0.5 + 0.5 * vNormalW.y);
      vNormalW = vec3(0.0, 1.0, 0.0);
    }
    vPosW = wp;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
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
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 n = normalize(vNormalW);
    // 両面を描く薄い布（帽子の縁のフリルなど）は裏から見たら法線を返す
    if (!gl_FrontFacing) n = -n;
    float h = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
    float tDeep = smoothstep(uThreshold2 - uSoftness, uThreshold2 + uSoftness, h);
    float tLit  = smoothstep(uThreshold  - uSoftness, uThreshold  + uSoftness, h);
    vec3 col = mix(uDeep, uShade, tDeep);
    col = mix(col, uLit, tLit);
    vec3 v = normalize(cameraPosition - vPosW);
    float rim = pow(1.0 - abs(dot(n, v)), 3.0);
    col = mix(col, uRimColor, rim * uRim);
    gl_FragColor = vec4(darken(col), 1.0);
    #include <colorspace_fragment>
  }
`;

export function createAccessoryMaterial(
  body: THREE.ShaderMaterial,
  colors: ToonColors,
  opts: { doubleSide?: boolean; rim?: number; ground?: number } = {},
): THREE.ShaderMaterial {
  const b = body.uniforms;
  return new THREE.ShaderMaterial({
    uniforms: {
      uLit: { value: new THREE.Color(colors.lit) },
      uShade: { value: new THREE.Color(colors.shade) },
      uDeep: { value: new THREE.Color(colors.deep) },
      uRimColor: { value: new THREE.Color(colors.rim) },
      uRim: { value: opts.rim ?? 0.25 },
      uLightDir: b.uLightDir,
      uThreshold: b.uThreshold,
      uThreshold2: b.uThreshold2,
      uSoftness: b.uSoftness,
      // 暗がりに沈める量はこの材質のもの（体と共有すると、同じ作り方の森の木やケースの皿まで暗くなる）
      uDarken: { value: 0 },
      // 地面で止める高さ（部品によっては向きに合わせて描く側から変える）
      uGround: { value: opts.ground ?? GROUND_ACCESSORY },
    },
    vertexShader,
    fragmentShader,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
}
