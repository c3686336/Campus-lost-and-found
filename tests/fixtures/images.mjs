// ImageMagick-generated 3x2, two-color raster images; animations contain two
// contrasting frames. Keep real encoded pixels rather than signature stubs.
export const images = [
  { name: 'colors.png', type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAABlBMVEXuiCIiiMxYxVGNAAAADElEQVQI12NIYHgAAAIEAUGP4m1CAAAAAElFTkSuQmCC' },
  { name: 'colors.jpg', type: 'image/jpeg', base64: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABkQAQEBAAMAAAAAAAAAAAAAAAIBAwARMf/EABQBAQAAAAAAAAAAAAAAAAAAAAj/xAAbEQEAAwADAQAAAAAAAAAAAAABAgMhAAQRMf/aAAwDAQACEQMRAD8AM6aPVrXVpt2pJXu23228QdFFXVqjRREjCIAAAAeABgBgGBw2X329m2V98mU5Kqvqrqq6q6r95//Z' },
  { name: 'colors.gif', type: 'image/gif', base64: 'R0lGODlhAwACAPAAAO6IIiKIzCH5BAAAAAAALAAAAAADAAIAAAIDRH4FADs=' },
  { name: 'colors.webp', type: 'image/webp', base64: 'UklGRkYAAABXRUJQVlA4IDoAAAAwAgCdASoDAAIAAgA0JagCdLoB+AChAAcmAAD+5AnO9vPv4X/ya6tqIMt2reXD/zFt1rXaBE6fckAA' },
  { name: 'lossless.webp', type: 'image/webp', base64: 'UklGRiIAAABXRUJQVlA4TBYAAAAvAkAAAA8wiKdxv4jq/McSbnAQ0f8Q' },
  { name: 'animated.gif', type: 'image/gif', base64: 'R0lGODlhAwACAPAAAO6IIiKIzCH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAwACAAACA0R+BQAh+QQAFAAAACwAAAAAAwACAIARd93ddzMCA0R+BQA7' },
  { name: 'animated.webp', type: 'image/webp', base64: 'UklGRtoAAABXRUJQVlA4WAoAAAACAAAAAgAAAQAAQU5JTQYAAAD/////AABBTk1GUgAAAAAAAAAAAAIAAAEAAMgAAAJWUDggOgAAADACAJ0BKgMAAgACADQlqAJ0ugH4AKEAByYAAP7kCc728+/hf/Jrq2ogy3at5cP/MW3WtdoETp9yQABBTk1GVAAAAAAAAAAAAAIAAAEAAMgAAABWUDggPAAAAPQBAJ0BKgMAAgAAADQlqAJ0ugH4AASDAAD+2QP9GEn4vv/lWCzjwQASWWlv9/+TXWHuJgMwaXlDiAAAAA==' },
].map(({ base64, ...file }) => ({ ...file, data: `data:${file.type};base64,${base64}` }));

// A complete, decodable PNG beyond the permitted 8192-pixel edge length.
export const oversizedImage = {
  name: 'wide.png', type: 'image/png',
  data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAIAEAAAABAQAAAACx8nbzAAAAEUlEQVQ4y2NgGAWjYBSMXAAABAIAAXxjA9AAAAAASUVORK5CYII=',
};

const fabricatedWebp = Buffer.alloc(25);
fabricatedWebp.write('RIFF');
fabricatedWebp.writeUInt32LE(17, 4);
fabricatedWebp.write('WEBPVP8 ', 8);
export const invalidImages = [
  ['image/png', Buffer.from([137,80,78,71,13,10,26,10])],
  ['image/jpeg', Buffer.from([255,216,255])],
  ['image/webp', Buffer.from('RIFF0000WEBP')],
  ['image/webp', fabricatedWebp],
  ['image/gif', Buffer.from('474946383961010001000000002c00000000003b', 'hex')],
  // Headers and chunk names are intact, but the PNG's compressed pixels fail.
  ['image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYfQAAAAASUVORK5CYII=', 'base64')],
].map(([type, bytes], index) => ({ name: `invalid-${index}`, type, data: `data:${type};base64,${bytes.toString('base64')}` }));
