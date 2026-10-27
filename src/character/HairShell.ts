import * as THREE from 'three';
import type { Accessory, AttachContext, OutfitParams } from './types';
import { GROUND_HAIR, groundClampGlsl } from '../render/ground';
import { DARKEN_GLSL } from '../render/toonMaterial';

/**
 * 髪：体の描画メッシュを法線方向へ少し浮かせた「殻」に、髪の形を貼る。
 * 殻は体と同じ頂点を使うので、跳ねる・這う・寝転がるなどの変形にそのまま追従する。
 *
 * 髪の形は顔座標の平面に描く（HairStyle.draw）。描く平面は横が一周（-π〜π、0 が正面）、
 * 縦は顔座標の y（HAIR_RECT の範囲）。3枚の層に描く：
 *   mask  … 髪のある所（塗りつぶす）
 *   lines … 毛の流れの線（髪の外周の線は mask から自動で引く）
 *   light … ツヤの光
 */
export const HAIR_RECT = { yMin: -2.6, yMax: 2.2 } as const;
const TEX_W = 2048;
const TEX_H = Math.round((TEX_W * (HAIR_RECT.yMax - HAIR_RECT.yMin)) / (2 * Math.PI));
/** 体の底から、高さに対してこの比までは髪を貼らない（寝転がったとき底に髪が回り込まないように） */
const FLOOR = 0.1;
/** 髪の外周の線の太さ（テクスチャのピクセル） */
const EDGE_PX = 3;

export interface HairColors {
  lit: string;
  shade: string;
  deep: string;
  /** 毛の線と外周の線 */
  line: string;
  /** ツヤ */
  light: string;
}

export interface HairLayers {
  mask: CanvasRenderingContext2D;
  lines: CanvasRenderingContext2D;
  light: CanvasRenderingContext2D;
}

export interface HairStyle {
  colors: HairColors;
  /** 顔座標（単位：頭の半径、y が上）に変換済みの3枚の層に髪を描く。parts は髪型のパーツごとの選択 */
  draw(layers: HairLayers, parts: Record<string, string>): void;
}

const vertexShader = /* glsl */ `
  ${groundClampGlsl(GROUND_HAIR)}
  uniform float uOffset;
  uniform float uWidth;      // 輪郭線のとき：画面上の太さ(px)。0 なら輪郭線ではない
  uniform vec2 uResolution;
  attribute vec3 aRest;
  varying vec3 vRest;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    // 物体の置き場（modelMatrix）も掛ける。掛けないと、体ごと見た目だけずらす震え（Yukkuri.tremble）で体だけ揺れて髪が止まって見えた
    vec3 n = normalize(mat3(modelMatrix) * normal);
    vec3 p = (modelMatrix * vec4(position, 1.0)).xyz + n * uOffset;
    // 地面に押し付けられた所は平らにつぶれる（寝転がったとき）
    if (clampToGround(p)) n = vec3(0.0, 1.0, 0.0);
    vPosW = p;
    vNormalW = n;
    vRest = aRest;
    vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
    if (uWidth > 0.0) {
      vec2 dir = (projectionMatrix * vec4(mat3(viewMatrix) * n, 0.0)).xy;
      float len = length(dir);
      if (len > 1e-5) clip.xy += (dir / len) * uWidth * 2.0 / uResolution * clip.w;
    }
    gl_Position = clip;
  }
`;

/** 顔座標 → 髪の平面の uv。toonMaterial の顔、FaceIndex と同じ式 */
const hairUv = /* glsl */ `
  uniform sampler2D uHairTex;
  uniform vec3 uHeadC;
  uniform float uHeadR;
  uniform float uFloor;  // これより下（静止形状の高さ）には髪を貼らない（体の底）
  vec4 hairSample(vec3 rest) {
    vec3 d = rest - uHeadC;
    float rxz = length(d.xz);
    float az = atan(d.x, d.z);
    float el = atan(d.y, rxz);
    float s = rxz / uHeadR;
    float fx = az * mix(s, 1.0, smoothstep(0.9, 1.8, abs(az)));
    float fy = el * length(d) / uHeadR;
    vec2 uv = vec2(fx / 6.2831853 + 0.5, (fy - ${HAIR_RECT.yMin.toFixed(3)}) / ${(HAIR_RECT.yMax - HAIR_RECT.yMin).toFixed(3)});
    vec4 t = texture2D(uHairTex, uv);
    // 底の近くは毛先が波打って終わる
    if (rest.y < uFloor + 0.012 * sin(az * 23.0)) t.a = 0.0;
    return t;
  }
`;

const fragmentShader = /* glsl */ `
  ${hairUv}
  uniform vec3 uLit;
  uniform vec3 uShade;
  uniform vec3 uDeep;
  uniform vec3 uLine;
  uniform vec3 uLight;
  uniform vec3 uLightDir;
  uniform float uThreshold;
  uniform float uThreshold2;
  uniform float uSoftness;
  ${DARKEN_GLSL}
  varying vec3 vRest;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec4 t = hairSample(vRest);
    if (t.a < 0.5) discard;
    vec3 n = normalize(vNormalW);
    float h = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
    float tDeep = smoothstep(uThreshold2 - uSoftness, uThreshold2 + uSoftness, h);
    float tLit  = smoothstep(uThreshold  - uSoftness, uThreshold  + uSoftness, h);
    vec3 col = mix(uDeep, uShade, tDeep);
    col = mix(col, uLit, tLit);
    col = mix(col, uLight, t.g);       // ツヤ
    col = mix(uLine, col, t.r);        // 毛の線・外周の線（r が小さいほど線）
    gl_FragColor = vec4(darken(col), 1.0);
    #include <colorspace_fragment>
  }
`;

const outlineFragment = /* glsl */ `
  ${hairUv}
  uniform vec3 uColor;
  varying vec3 vRest;
  void main() {
    if (hairSample(vRest).a < 0.5) discard;
    gl_FragColor = vec4(uColor, 1.0);
    #include <colorspace_fragment>
  }
`;

export class HairShell implements Accessory {
  readonly object = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly outline: THREE.ShaderMaterial;
  private texture: THREE.DataTexture;

  constructor(ctx: AttachContext, private readonly style: HairStyle, private readonly params: OutfitParams) {
    this.texture = paintHair(style, params.hairParts);
    const b = ctx.bodyMaterial.uniforms;
    const o = ctx.outlineMaterial.uniforms;
    const c = style.colors;
    const shared = {
      uHairTex: { value: this.texture },
      // 顔と同じ基準点・大きさ（体型を変えると一緒に変わる）
      uHeadC: b.uHeadC,
      uHeadR: b.uHeadR,
      uOffset: { value: 0.01 },
      uFloor: { value: -1e3 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uWidth: { value: 0 },
        uResolution: o.uResolution,
        uLit: { value: new THREE.Color(c.lit) },
        uShade: { value: new THREE.Color(c.shade) },
        uDeep: { value: new THREE.Color(c.deep) },
        uLine: { value: new THREE.Color(c.line) },
        uLight: { value: new THREE.Color(c.light) },
        uLightDir: b.uLightDir,
        uThreshold: b.uThreshold,
        uThreshold2: b.uThreshold2,
        uSoftness: b.uSoftness,
        uDarken: { value: 0 },
      },
      vertexShader,
      fragmentShader,
    });
    // 髪のふちの輪郭線（背面法。体の輪郭線と同じ太さ・色）
    this.outline = new THREE.ShaderMaterial({
      uniforms: { ...shared, uWidth: o.uWidth, uResolution: o.uResolution, uColor: o.uColor },
      vertexShader,
      fragmentShader: outlineFragment,
      side: THREE.BackSide,
    });
    for (const m of [this.outline, this.material]) {
      const mesh = new THREE.Mesh(ctx.geometry, m);
      mesh.frustumCulled = false;
      this.object.add(mesh);
    }
  }

  /** 髪型（パーツの選択）が変わったときに描き直す */
  repaint(): void {
    const old = this.texture;
    this.texture = paintHair(this.style, this.params.hairParts);
    this.material.uniforms.uHairTex.value = this.texture;
    this.outline.uniforms.uHairTex.value = this.texture;
    old.dispose();
  }

  rebuild(ctx: AttachContext): void {
    const ix = ctx.index;
    this.material.uniforms.uFloor.value = ix.minY + (ix.maxY - ix.minY) * FLOOR;
    this.update(ctx);
  }

  update(ctx: AttachContext): void {
    const off = ctx.index.headR * this.params.hairThickness;
    this.material.uniforms.uOffset.value = off;
    this.outline.uniforms.uOffset.value = off;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.outline.dispose();
  }
}

/** 髪の形を3枚の層に描き、1枚のテクスチャ（r：線の濃さの逆、g：ツヤ、a：髪のある所）にまとめる */
function paintHair(style: HairStyle, parts: Record<string, string>): THREE.DataTexture {
  const layer = () => {
    const c = document.createElement('canvas');
    c.width = TEX_W;
    c.height = TEX_H;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const k = TEX_W / (2 * Math.PI);
    ctx.setTransform(k, 0, 0, -k, TEX_W / 2, HAIR_RECT.yMax * k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    return ctx;
  };
  const layers: HairLayers = { mask: layer(), lines: layer(), light: layer() };
  style.draw(layers, parts);
  const mask = layers.mask.getImageData(0, 0, TEX_W, TEX_H).data;
  const lines = layers.lines.getImageData(0, 0, TEX_W, TEX_H).data;
  const light = layers.light.getImageData(0, 0, TEX_W, TEX_H).data;

  // 外周の線：髪のある所のうち、EDGE_PX 以内に髪のない所があるピクセル（縮めた形との差）
  const n = TEX_W * TEX_H;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = mask[4 * i + 3] > 127 ? 1 : 0;
  const eroded = erode(inside, TEX_W, TEX_H, EDGE_PX);

  const data = new Uint8Array(n * 4);
  for (let y = 0; y < TEX_H; y++) {
    // テクスチャの行は下から数える
    const row = TEX_H - 1 - y;
    for (let x = 0; x < TEX_W; x++) {
      const i = y * TEX_W + x;
      const o = 4 * (row * TEX_W + x);
      const edge = inside[i] && !eroded[i] ? 1 : 0;
      const line = Math.max(edge, lines[4 * i + 3] / 255);
      data[o] = Math.round(255 * (1 - line));
      data[o + 1] = light[4 * i + 3];
      data[o + 2] = 0;
      data[o + 3] = mask[4 * i + 3];
    }
  }
  const tex = new THREE.DataTexture(data, TEX_W, TEX_H, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 2値画像を半径 r だけ縮める（横・縦に分けた最小値フィルタ。横は一周つながる） */
function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let k = -r; k <= r && v; k++) v = src[y * w + ((x + k + w) % w)];
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let k = -r; k <= r && v; k++) {
        const yy = y + k;
        v = yy < 0 || yy >= h ? 1 : tmp[yy * w + x];
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
