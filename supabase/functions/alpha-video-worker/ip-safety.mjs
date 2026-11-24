const IPV4_SPECIAL_RANGES = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 31, 196, 0], 24],
  [[192, 52, 193, 0], 24],
  [[192, 175, 48, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function ipv4Number(parts) {
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]);
}

export function isPublicIpv4(raw) {
  const parts = raw.split(".");
  if (parts.length !== 4 || parts.some((part) =>
    !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255
  )) return false;

  const value = ipv4Number(parts.map(Number));
  return !IPV4_SPECIAL_RANGES.some(([network, prefix]) => {
    const base = ipv4Number(network);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (base & mask);
  });
}
