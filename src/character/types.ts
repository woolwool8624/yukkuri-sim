import type * as THREE from 'three';
import type { FaceIndex } from './FaceIndex';

/**
 * キャラクター（髪・帽子・リボンなどの装飾）の型定義。
 *
 * 装飾は「アクセサリー」の集まり。アクセサリーは体の表面の点に追従して動く部品で、
 *   ・髪（HairShell）  … 体の表面から少し浮かせた殻に、髪の形を貼ったもの。体の変形にそのまま追従する
 *   ・帽子（WitchHat） … 立体の部品。頭のまわりの4点から向きを決めて載せる
 *   ・三つ編み（Braid）… 体の表面に沿って垂れる編み目の列
 * などがある。キャラクターを足すときは character/ に1ファイル作り、index.ts に登録する。
 *
 * 位置の指定は顔と同じ顔座標（頭の正面が原点、単位は頭の半径、y が上）を使う。
 * 顔の部品と同じ座標なので、体型を変えても前髪と目の位置関係が保たれる。
 */

/** アクセサリーを作る・動かすときに渡す情報 */
export interface AttachContext {
  /** 体の描画メッシュ（髪の殻はこれを共有する） */
  geometry: THREE.BufferGeometry;
  /** 体の描画メッシュの今の頂点位置・法線（ワールド座標） */
  pos: Float32Array;
  nrm: Float32Array;
  /** 静止形状の頂点を顔座標で引く索引 */
  index: FaceIndex;
  /** 立ち止まって落ち着いているか（false のときは、動きで変わる長さから数などを決め直さない）。未設定は true 扱い */
  still?: boolean;
  /** こーろこーろで転がっているか（帽子は根元を太らせずに帽子ごと浮かせて頭をよける）。未設定は false 扱い */
  rolling?: boolean;
  /** 体の塗り（光の向きなどを共有する） */
  bodyMaterial: THREE.ShaderMaterial;
  /** 輪郭線の材質（共有。画面上で一定の太さ） */
  outlineMaterial: THREE.ShaderMaterial;
}

export interface Accessory {
  readonly object: THREE.Object3D;
  /** 体型が変わったときに呼ぶ（取り付け位置・大きさを決め直す） */
  rebuild(ctx: AttachContext): void;
  /** 描画の直前に呼ぶ（体の今の形に合わせて動かす） */
  update(ctx: AttachContext): void;
  dispose?(): void;
}

/** 調整パネルで変えられる、装飾の調整値（キャラクター共通） */
export interface OutfitParams {
  showHair: boolean;
  showHat: boolean;
  showBraid: boolean;
  /** 帽子の大きさ（1 = 標準） */
  hatScale: number;
  /** 帽子の位置の調整（かぶる所の半径が単位。大きさは変わらない）：左右（+ で右）・上下（+ で上）・前後（+ で前） */
  hatX: number;
  hatY: number;
  hatZ: number;
  /** 帽子の傾き（度）：前後（+ で前のつばが上がる）と左右（+ で右が下がる） */
  hatTilt: number;
  hatSide: number;
  /** 髪の厚み（頭の半径に対する比） */
  hairThickness: number;
  /** 三つ編みの長さ（付け根から体の下端までに対する比。1 で下端まで）。三つ編みは簡易的な手としても使う */
  braidLength: number;
  /** 髪型のパーツごとの選択（パーツ → 選択肢の id）。パーツと選択肢はキャラクターごと（CharacterDef.hairParts） */
  hairParts: Record<string, string>;
}

/** 髪型のパーツ（前髪・横髪など）と、その選択肢 */
export interface HairPartDef {
  part: string;
  /** パーツ選択画面の行の名前 */
  label: string;
  /** 先頭が初期値 */
  options: { id: string; name: string }[];
}

export interface CharacterDef {
  id: string;
  /** 一覧に出す名前 */
  name: string;
  /** セリフで使う種族の呼び名（ひらがな。「ここをまりさのゆっくりぷれいすにするよ！」など） */
  kana?: string;
  /** 瞳の色（選んだときに顔に反映する） */
  iris?: string;
  /** 髪型のパーツ（選べるもの）。なければ髪型は選べない */
  hairParts?: HairPartDef[];
  /** このキャラクターに合う調整値の初期値 */
  defaults?: Partial<OutfitParams>;
  /** 体型ごとの初期値（体型 ID → defaults に重ねる値。帽子の位置など、体型で合わせた値） */
  presetDefaults?: Record<string, Partial<OutfitParams>>;
  /** アクセサリーを作る */
  create(ctx: AttachContext, params: OutfitParams): Accessory[];
}
