/**
 * 地面（y = 0 の平面）。装飾（髪・帽子・リボンなど）は地面より下に行かないよう、
 * 頂点をこの高さで止める（寝転がったとき地面に押し付けられて平らにつぶれる）。
 * 重なる部品どうしがちらつかないよう、部品ごとに少しずつ高さを変える
 */
export const GROUND_Y = 0;
// 帽子は髪のすぐ上に重ねる（差が大きいと、地面に倒れた帽子の縁と地面のすき間から髪がのぞく）。
// 1mm の差でも奥行きの精度は足りる（2m 先で 0.003mm ほど）
/** 髪の殻を止める高さ */
export const GROUND_HAIR = GROUND_Y + 0.002;
/** 装飾の輪郭線を止める高さ（髪より上、部品より下。部品の下に隠れる） */
export const GROUND_OUTLINE = GROUND_Y + 0.003;
/** 帽子の円錐と帯を止める高さ（寝転がって折れると、つばの下で地面に押し付けられる） */
export const GROUND_CROWN = GROUND_Y + 0.004;
/** 帽子のつばを止める高さ（円錐より上） */
export const GROUND_BRIM = GROUND_Y + 0.005;
/** リボン・三つ編みを止める高さ */
export const GROUND_ACCESSORY = GROUND_Y + 0.02;
/** 帽子のフリルを止める高さ（地面に垂らしたつばの下面より上） */
export const GROUND_FRILL = GROUND_Y + 0.045;
/**
 * 帽子が上を向いたまま地面に押し付けられたとき（深く前へ傾く）のフリルの高さ：フリルはつばの地面の側にあるので、
 * つばより下・髪より上で止める（GROUND_FRILL のままだと、地面に押し付けたつばの上に白く出た）
 */
export const GROUND_FRILL_LOW = GROUND_Y + 0.0035;

/**
 * 装飾を地面で止めるとき、もとが上を向いていた面を下を向いていた面よりこれだけ高く置く（表と裏が同じ高さに重ならないように）。
 * 部品ごとの止める高さの差（1mm）より小さく
 */
export const GROUND_LAYER = 0.0008;

/** GLSL：ワールド座標 wp を地面の上に止める。止めたときは法線 n を上向きにする */
export function groundClampGlsl(height: number): string {
  return /* glsl */ `
  bool clampToGround(inout vec3 wp) {
    if (wp.y >= ${height.toFixed(4)}) return false;
    wp.y = ${height.toFixed(4)};
    return true;
  }
`;
}
