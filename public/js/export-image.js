// Converte o nó do relatório em PNG sem bibliotecas: DOM → SVG <foreignObject> → canvas.
// O CSS do relatório e as fontes Geist são embutidos para o PNG ficar idêntico à tela.

let cssCache = null;
let fontCache = null;

async function toDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function embeddedCss() {
  if (!cssCache) cssCache = fetch('/css/report.css').then((r) => r.text());
  if (!fontCache) {
    fontCache = Promise.all([
      toDataUrl('/fonts/Geist-Variable.woff2'),
      toDataUrl('/fonts/GeistMono-Variable.woff2'),
    ]).then(([sans, mono]) => `
      @font-face { font-family: 'Geist'; src: url(${sans}) format('woff2'); font-weight: 100 900; }
      @font-face { font-family: 'Geist Mono'; src: url(${mono}) format('woff2'); font-weight: 100 900; }`);
  }
  const [css, fonts] = await Promise.all([cssCache, fontCache]);
  return fonts + '\n' + css;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Falha ao renderizar a imagem do relatório.'));
    img.src = src;
  });
}

export async function nodeToPngBlob(node, scale = 2) {
  await document.fonts.ready;
  const width = Math.ceil(node.offsetWidth);
  const height = Math.ceil(node.offsetHeight);
  const css = await embeddedCss();
  const html = new XMLSerializer().serializeToString(node);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <foreignObject x="0" y="0" width="${width}" height="${height}">
      <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;margin:0;padding:0">
        <style><![CDATA[${css}]]></style>
        ${html}
      </div>
    </foreignObject>
  </svg>`;

  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  // Primeiro desenho aquece as fontes embutidas; o segundo sai com a tipografia correta.
  ctx.drawImage(img, 0, 0);
  await new Promise((r) => setTimeout(r, 60));
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar PNG.'))), 'image/png');
  });
}

export const canCopyImage = () => Boolean(window.isSecureContext && navigator.clipboard?.write && window.ClipboardItem);

export async function copyImage(node) {
  // O ClipboardItem recebe a Promise direto para manter o "gesto do usuário" válido.
  const item = new ClipboardItem({ 'image/png': nodeToPngBlob(node) });
  await navigator.clipboard.write([item]);
}

export async function downloadImage(node, filename) {
  const blob = await nodeToPngBlob(node);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
