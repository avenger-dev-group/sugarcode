const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const COPY_PADDING = 24;
const COPY_PIXEL_RATIO = 2;
const MAX_COPY_EDGE = 4096;
const MAX_COPY_PIXELS = 12_000_000;

export type DrawioImageDimensions = Readonly<{
  height: number;
  width: number;
}>;

export const fitDrawioImageDimensions = (
  logicalWidth: number,
  logicalHeight: number,
): DrawioImageDimensions => {
  const width = Math.max(1, logicalWidth);
  const height = Math.max(1, logicalHeight);
  const scale = Math.min(
    COPY_PIXEL_RATIO,
    MAX_COPY_EDGE / Math.max(width, height),
    Math.sqrt(MAX_COPY_PIXELS / (width * height)),
  );
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
};

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 图片编码失败。'));
    }, 'image/png');
  });

const renderSvgBlobAsPng = async (
  svgBlob: Blob,
  dimensions: DrawioImageDimensions,
): Promise<Blob> => {
  const objectUrl = URL.createObjectURL(svgBlob);
  const image = new Image();
  image.decoding = 'async';
  try {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener(
        'error',
        () => reject(new Error('无法解析图表图片。')),
        { once: true },
      );
      image.src = objectUrl;
    });
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建图片画布。');
      context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
      return await canvas.convertToBlob({ type: 'image/png' });
    }
    const canvas = window.document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建图片画布。');
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

export const copyDrawioSvgAsPng = async ({
  bounds,
  clipboard = navigator.clipboard,
  svg,
  viewScale,
}: Readonly<{
  bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
  clipboard?: Pick<Clipboard, 'write'>;
  svg: SVGSVGElement;
  viewScale: number;
}>): Promise<void> => {
  if (typeof ClipboardItem === 'undefined') {
    throw new Error('当前环境不支持复制图片。');
  }
  const scale = Math.max(0.01, viewScale);
  const padding = COPY_PADDING * scale;
  const viewBox = {
    height: Math.max(1, bounds.height + padding * 2),
    width: Math.max(1, bounds.width + padding * 2),
    x: bounds.x - padding,
    y: bounds.y - padding,
  };
  const dimensions = fitDrawioImageDimensions(
    viewBox.width / scale,
    viewBox.height / scale,
  );
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', SVG_NAMESPACE);
  clone.setAttribute(
    'viewBox',
    `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`,
  );
  clone.setAttribute('width', String(dimensions.width));
  clone.setAttribute('height', String(dimensions.height));
  clone.removeAttribute('style');
  clone.querySelectorAll('[visibility="hidden"]').forEach((node) => node.remove());
  clone.querySelectorAll<SVGPathElement>('.drawio-flow-path').forEach((path) => {
    path.classList.remove('drawio-flow-path');
    path.style.removeProperty('animation');
    path.removeAttribute('data-drawio-flow-original-dasharray');
  });
  const background = window.document.createElementNS(SVG_NAMESPACE, 'rect');
  background.setAttribute('x', String(viewBox.x));
  background.setAttribute('y', String(viewBox.y));
  background.setAttribute('width', String(viewBox.width));
  background.setAttribute('height', String(viewBox.height));
  background.setAttribute('fill', '#ffffff');
  clone.insertBefore(background, clone.firstChild);
  const source = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const pngPromise = renderSvgBlobAsPng(svgBlob, dimensions);
  await clipboard.write([
    new ClipboardItem({ 'image/png': pngPromise }),
  ]);
};
