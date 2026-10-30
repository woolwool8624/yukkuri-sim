/**
 * 食べ物の種類。品質ごとに、食べたときに減るストレスが違う（減る量は Stress の params.meal）。
 * おまんじゅう（ごはん）は中間品質（指示）。餌集めの小さな餌：木の実（中間品質）・草と虫（低品質）
 */
export type FoodQuality = 'low' | 'normal' | 'high';

export const QUALITY_NAMES: Record<FoodQuality, string> = { low: '低品質', normal: '中間品質', high: '高品質' };

export interface FoodKind {
  id: string;
  name: string;
  quality: FoodQuality;
}

export const FOODS: FoodKind[] = [
  { id: 'manju', name: 'おまんじゅう', quality: 'normal' },
  // 餌集めで拾う小さな餌（帽子のつばに乗せる）
  { id: 'acorn', name: '木の実', quality: 'normal' },
  { id: 'grass', name: '草', quality: 'low' },
  { id: 'bug', name: '虫', quality: 'low' },
  // 自然の中に生えている餌（森・平地。2026-10-31）
  { id: 'mushroom', name: 'きのこ', quality: 'normal' },
  { id: 'flower', name: 'お花', quality: 'low' },
];

/** id の食べ物 */
export function findFood(id: string): FoodKind {
  return FOODS.find((f) => f.id === id) ?? FOODS[0];
}

/** 「食べ物をあげる」で出すもの */
export const DEFAULT_FOOD = FOODS[0];
