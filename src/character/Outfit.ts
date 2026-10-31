import * as THREE from 'three';
import { loadJSON, saveJSON } from '../platform/storage';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { FaceIndex, readVertex } from './FaceIndex';
import { HairShell } from './HairShell';
import { Braid } from './Braid';
import { WitchHat } from './WitchHat';
import { findCharacter } from './index';
import type { Accessory, AttachContext, CharacterDef, OutfitParams } from './types';

const STORAGE_KEY = 'outfit';

export const DEFAULT_OUTFIT: OutfitParams = {
  showHair: true,
  showHat: true,
  showBraid: true,
  hatScale: 1,
  hatX: 0,
  hatY: 0,
  hatZ: 0,
  hatTilt: 5,
  hatSide: 6,
  hairThickness: 0.035,
  braidLength: 0.75,
  hairParts: {},
};

/** 体型ごとに別々に持つ調整値（帽子の大きさ・位置・傾き、髪の厚み、三つ編みの長さ） */
const FIT_KEYS = ['hatScale', 'hatX', 'hatY', 'hatZ', 'hatTilt', 'hatSide', 'hairThickness', 'braidLength'] as const;
type Fit = Pick<OutfitParams, (typeof FIT_KEYS)[number]>;

interface Saved {
  character: string;
  params: OutfitParams;
  /** 体型 ID → その体型の調整値（初期値のままの体型は持たない） */
  fits?: Record<string, Fit>;
}

/**
 * ゆっくり1体の装飾（キャラクター）。選んだキャラクターのアクセサリーを作り、
 * 体型が変わったら付け直し、毎フレーム体の形に合わせて動かす
 */
export class Outfit {
  readonly object = new THREE.Group();
  readonly params: OutfitParams;
  characterId: string;
  /** 保存された設定がなかった（初めて開いた） */
  readonly fresh: boolean;
  private parts: Accessory[] = [];
  /** 体型 ID → 調整値（初期値から変えた体型だけ） */
  private fits: Record<string, Fit>;
  /** 今の体型（調整値をどの体型のものとして読み書きするか） */
  private presetId = '';
  /** 体型ごとに持つ前の版で保存した調整値（最初に使う体型に引き継ぐ） */
  private legacyFit: Fit | null = null;
  private readonly index = new FaceIndex();
  private buildCount = 0;
  private readonly ctx: AttachContext;

  constructor(geometry: THREE.BufferGeometry, bodyMaterial: THREE.ShaderMaterial, outlineMaterial: THREE.ShaderMaterial) {
    const stored = loadJSON<Partial<Saved>>(STORAGE_KEY);
    const saved = stored ?? {};
    this.fresh = stored === null || stored === undefined;
    this.characterId = saved.character ?? 'none';
    this.params = { ...DEFAULT_OUTFIT, ...saved.params };
    this.params.hairParts = { ...this.params.hairParts };
    delete (this.params as unknown as Record<string, unknown>).hatHeight; // 旧版の調整値
    this.fits = { ...saved.fits };
    if (!saved.fits && saved.params) this.legacyFit = pickFit(this.params);
    this.ctx = {
      geometry,
      pos: geometry.getAttribute('position').array as Float32Array,
      nrm: new Float32Array(0),
      index: this.index,
      bodyMaterial,
      // 体と同じ輪郭線（太さ・色を共有）。地面より下に行かない
      outlineMaterial: createAccessoryOutlineMaterial(outlineMaterial),
    };
  }

  get character(): CharacterDef {
    return findCharacter(this.characterId);
  }

  /** キャラクターを切り替える（調整値はそのキャラクターの初期値に戻す） */
  setCharacter(id: string, resetParams = true): void {
    this.characterId = id;
    if (resetParams) {
      const d = findCharacter(id).defaults;
      Object.assign(this.params, DEFAULT_OUTFIT, d);
      // 入れ物ごと共有しないよう写す（選ぶと初期値まで書き換わってしまう）
      this.params.hairParts = { ...d?.hairParts };
      this.fits = {};
      this.legacyFit = null;
    }
    this.create();
    this.save();
  }

  /**
   * 体型を切り替える：体型ごとの調整値を、その体型で保存したもの（なければキャラクターの初期値）にする。
   * 付け直しは呼び出し側で（体型を置き直すときに一緒に行われる）
   */
  usePreset(id: string): void {
    this.presetId = id;
    const fit = this.legacyFit ?? this.fits[id];
    this.legacyFit = null;
    Object.assign(this.params, this.fitDefaults(), fit);
    this.save();
  }

  /** 今の体型の調整値（帽子・髪の厚み・三つ編みの長さ）を、キャラクターの初期値に戻す。付け直しは呼び出し側で */
  resetFit(): void {
    delete this.fits[this.presetId];
    Object.assign(this.params, this.fitDefaults());
    this.save();
  }

  /** 今の体型ごとの調整値を、別の体型（ユーザー設定など）にも写す */
  copyFitTo(id: string): void {
    if (id === this.presetId) return;
    const fit = pickFit(this.params);
    if (sameFit(fit, this.fitDefaults(id))) delete this.fits[id];
    else this.fits[id] = fit;
    this.save();
  }

  /** 体型 id の初期値（キャラクターの初期値に、体型ごとの初期値を重ねたもの） */
  private fitDefaults(id = this.presetId): Fit {
    return pickFit({ ...DEFAULT_OUTFIT, ...this.character.defaults, ...this.character.presetDefaults?.[id] });
  }

  /**
   * 体型に合わせて制限した調整値（帽子の前後の傾き）を、調整値そのものにも反映する。
   * 画面で動かしたとき用（スライダーが制限の所で止まる）。変わったら true
   */
  applyLimits(): boolean {
    const hat = this.parts.find((a): a is WitchHat => a instanceof WitchHat);
    if (!hat || hat.tiltUsed === this.params.hatTilt) return false;
    this.params.hatTilt = hat.tiltUsed;
    return true;
  }

  /** アクセサリーを作り直す */
  create(): void {
    for (const a of this.parts) {
      this.object.remove(a.object);
      a.dispose?.();
    }
    this.parts = this.character.create(this.ctx, this.params);
    for (const a of this.parts) this.object.add(a.object);
    // 三つ編みの編み始めは帽子の外へ、つばを突き抜けた所は隠す（帽子を表示しているときだけ）
    const hat = this.parts.find((a): a is WitchHat => a instanceof WitchHat);
    for (const a of this.parts) {
      if (a instanceof Braid && hat) {
        a.cover = (p) => this.params.showHat && hat.covers(p);
        a.crossing = (p, q) => (this.params.showHat ? hat.brimCrossing(p, q) : 0);
      }
    }
    this.rebuild();
  }

  /** 体型（静止形状・顔の位置）が変わったときに呼ぶ */
  rebuild(): void {
    this.buildCount++;
    const u = this.ctx.bodyMaterial.uniforms;
    const rest = this.ctx.geometry.getAttribute('aRest');
    if (!rest) return;
    this.index.build(rest.array as Float32Array, u.uHeadC.value as THREE.Vector3, u.uHeadR.value as number);
    this.refreshArrays();
    for (const a of this.parts) a.rebuild(this.ctx);
    this.applyVisibility();
  }

  /**
   * 顔座標 (fx, fy)（単位は頭の半径）の今の位置と法線（ワールド座標）。
   * 体型を作る前などで求められないときは false
   */
  facePoint(fx: number, fy: number, pos: THREE.Vector3, nrm: THREE.Vector3): boolean {
    if (this.index.fx.length === 0) return false;
    this.refreshArrays();
    readVertex(this.ctx.pos, this.ctx.nrm, this.index.nearest(fx, fy), pos, nrm);
    return true;
  }

  /** 顔座標 (fx, fy) の所の、静止形状での床からの高さ（体の高さに対する比）。求められないときは -1 */
  restHeightAt(fx: number, fy: number): number {
    const ix = this.index;
    if (ix.fx.length === 0) return -1;
    return (ix.rest[3 * ix.nearest(fx, fy) + 1] - ix.minY) / Math.max(1e-6, ix.maxY - ix.minY);
  }

  /** 体型を作り直した回数（作り直すと頂点の番号の意味が変わるので、番号を覚えている側が選び直すのに使う） */
  get builds(): number {
    return this.buildCount;
  }

  /**
   * 体の表面の、向き az（顔の正面が 0、背中が π）・高さ height（床からの、高さに対する比）の所の
   * 今の位置と法線（ワールド座標）。求められないときは false
   */
  surfacePoint(az: number, height: number, pos: THREE.Vector3, nrm: THREE.Vector3): boolean {
    if (this.index.fx.length === 0) return false;
    this.refreshArrays();
    readVertex(this.ctx.pos, this.ctx.nrm, this.index.nearestAzHeight(az, height), pos, nrm);
    return true;
  }

  /**
   * 体の表面のうち、向き az のまわり ±azRange・高さ（床からの、静止形状の高さに対する比）maxHeight 以下の範囲で、
   * 今の高さ（ワールド）が targetY に一番近く、地面を向いていない所の今の位置と法線。求められないときは false
   */
  surfacePointAt(az: number, azRange: number, maxHeight: number, targetY: number, pos: THREE.Vector3, nrm: THREE.Vector3): boolean {
    const best = this.surfaceIndexAt(az, azRange, maxHeight, targetY);
    if (best < 0) return false;
    readVertex(this.ctx.pos, this.ctx.nrm, best, pos, nrm);
    return true;
  }

  /**
   * surfacePointAt の頂点の番号（vertexPoint で今の位置を読む）。求められないときは -1。
   * minNormalY：法線の上下の成分がこれより下向きの所（地面を向いている所）は選ばない。
   * azWeight：高さの差に足す、向きの差（ラジアン）の重み（大きいほど向き az の線から外れない）。
   * side：1 / -1 なら、向き az から片側（向きの差がその符号の側）だけを探す（0 なら両側）
   */
  surfaceIndexAt(az: number, azRange: number, maxHeight: number, targetY: number, minNormalY = -0.3, azWeight = 0.05, side = 0): number {
    const ix = this.index;
    if (ix.fx.length === 0) return -1;
    this.refreshArrays();
    const yMax = ix.minY + (ix.maxY - ix.minY) * maxHeight;
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    let best = -1, bs = Infinity;
    for (let i = 0; i < ix.az.length; i++) {
      const d = Math.atan2(Math.sin(ix.az[i] - az), Math.cos(ix.az[i] - az));
      const da = Math.abs(d);
      if (da > azRange || ix.rest[3 * i + 1] > yMax) continue;
      if (side !== 0 && d * side < -1e-3) continue;
      readVertex(this.ctx.pos, this.ctx.nrm, i, p, n);
      if (n.y < minNormalY) continue;
      const score = Math.abs(p.y - targetY) + da * azWeight;
      if (score < bs) { bs = score; best = i; }
    }
    return best;
  }

  /** 作ったアクセサリー（髪・三つ編み・帽子など） */
  get accessories(): readonly Accessory[] {
    return this.parts;
  }

  /** 帽子（表示しているときだけ。物を乗せるのに使う） */
  get hat(): WitchHat | null {
    if (!this.params.showHat) return null;
    return this.parts.find((a): a is WitchHat => a instanceof WitchHat) ?? null;
  }

  /** 三つ編み（表示しているときだけ。物を持つのに使う） */
  get braid(): Braid | null {
    if (!this.params.showBraid) return null;
    return this.parts.find((a): a is Braid => a instanceof Braid) ?? null;
  }

  /** 体の頂点 i の今の位置と法線（ワールド座標） */
  vertexPoint(i: number, pos: THREE.Vector3, nrm: THREE.Vector3): void {
    this.refreshArrays();
    readVertex(this.ctx.pos, this.ctx.nrm, i, pos, nrm);
  }

  /** 描画の直前に呼ぶ（体の描画メッシュを更新した後）。still：立ち止まって落ち着いているか。rolling：こーろこーろで転がっているか */
  update(still = true, rolling = false): void {
    if (this.parts.length === 0) return;
    this.ctx.still = still;
    this.ctx.rolling = rolling;
    this.refreshArrays();
    // 帽子を先に（三つ編みが帽子の今の位置を見るので）
    for (const a of this.parts) if (a instanceof WitchHat) a.update(this.ctx);
    for (const a of this.parts) if (!(a instanceof WitchHat)) a.update(this.ctx);
  }

  /** 髪型のパーツの今の選択（未選択なら先頭の選択肢） */
  hairPart(part: string): string {
    const def = this.character.hairParts?.find((p) => p.part === part);
    const id = this.params.hairParts[part];
    return def?.options.some((o) => o.id === id) ? id : (def?.options[0]?.id ?? '');
  }

  /** 髪型のパーツを選ぶ（髪を描き直して保存） */
  setHairPart(part: string, id: string): void {
    this.params.hairParts[part] = id;
    for (const a of this.parts) if (a instanceof HairShell) a.repaint();
    this.save();
  }

  applyVisibility(): void {
    for (const a of this.parts) {
      if (a instanceof HairShell) a.object.visible = this.params.showHair;
      else if (a instanceof WitchHat) a.object.visible = this.params.showHat;
      else if (a instanceof Braid) a.object.visible = this.params.showBraid;
    }
  }

  save(): void {
    if (this.presetId) {
      const fit = pickFit(this.params);
      if (sameFit(fit, this.fitDefaults())) delete this.fits[this.presetId];
      else this.fits[this.presetId] = fit;
    }
    saveJSON(STORAGE_KEY, { character: this.characterId, params: this.params, fits: this.fits } satisfies Saved);
  }

  private refreshArrays(): void {
    const g = this.ctx.geometry;
    this.ctx.pos = g.getAttribute('position').array as Float32Array;
    this.ctx.nrm = (g.getAttribute('normal')?.array as Float32Array) ?? new Float32Array(this.ctx.pos.length);
  }
}

function pickFit(p: OutfitParams): Fit {
  return Object.fromEntries(FIT_KEYS.map((k) => [k, p[k]])) as Fit;
}

function sameFit(a: Fit, b: Fit): boolean {
  return FIT_KEYS.every((k) => Math.abs(a[k] - b[k]) < 1e-9);
}
