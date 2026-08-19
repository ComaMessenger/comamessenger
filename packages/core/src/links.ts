const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function compactUUID(value: string): string {
  const hex = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("invalid UUID");
  const bytes = Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const left = bytes[index]!;
    const middle = bytes[index + 1];
    const right = bytes[index + 2];
    result += alphabet[left >> 2];
    result += alphabet[((left & 3) << 4) | ((middle ?? 0) >> 4)];
    if (middle != null)
      result += alphabet[((middle & 15) << 2) | ((right ?? 0) >> 6)];
    if (right != null) result += alphabet[right & 63];
  }
  return result;
}

export function expandUUID(value: string): string {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value))
    throw new Error("invalid compact UUID");
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const chunk = value.slice(index, index + 4);
    const numbers = [...chunk].map((character) => alphabet.indexOf(character));
    bytes.push((numbers[0]! << 2) | (numbers[1]! >> 4));
    if (chunk.length > 2)
      bytes.push(((numbers[1]! & 15) << 4) | (numbers[2]! >> 2));
    if (chunk.length > 3) bytes.push(((numbers[2]! & 3) << 6) | numbers[3]!);
  }
  if (bytes.length !== 16) throw new Error("invalid compact UUID");
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
