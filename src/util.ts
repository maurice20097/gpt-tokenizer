import sharp from 'sharp'
import { escapeRegExp } from './escapeRegExp.js'

export function getMaxValueFromMap(map: Map<unknown, number>): number {
  let max = 0
  map.forEach((val) => {
    max = Math.max(max, val)
  })
  return max
}

export function getSpecialTokenRegex(tokens: Set<string>): RegExp {
  const escapedTokens = [...tokens].map(escapeRegExp)
  const inner = escapedTokens.join('|')
  return new RegExp(`(${inner})`)
}

export async function processImageFromUrl(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const metadata = await sharp(buffer).metadata();
    return {
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    console.error("Error processing image:", error);
  }
}
