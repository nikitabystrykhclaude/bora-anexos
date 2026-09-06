'use strict';
/**
 * bora-anexos — descarga y transcribe los anexos del Boletín Oficial argentino.
 *
 * El problema que resuelve. Muchas normas argentinas ponen lo importante en los
 * anexos: los montos de una resolución de ANSES, el cuadro de tasas de un
 * decreto, el cronograma de pagos del año. Y los anexos no se pueden enlazar:
 * en la página del aviso son llamadas JavaScript a `descargarPDFAnexo(...)`,
 * que hacen un POST y reciben el PDF codificado en base64. No hay URL que
 * copiar, no hay nada que un scraper normal encuentre.
 *
 * Y cuando el PDF está en la mano, todavía falta. Los PDF que produce el
 * sistema GEDO usan fuentes subseteadas con codificación propia: leer los
 * streams y sacar las cadenas entre paréntesis devuelve basura del tipo
 * `#$%%`. Hay que pasar cada byte por el CMap de /ToUnicode de la fuente
 * activa, y para eso hace falta seguir los operadores Tf del content stream.
 *
 * Esta biblioteca hace las dos cosas.
 *
 * Lo que NO hace: OCR. Hay dos formas de que un número quede fuera de alcance,
 * y conviene no confundirlas. Un anexo puede venir escaneado, y entonces
 * `analizar` lo dice en vez de devolver un texto vacío como si estuviera en
 * blanco. Y una norma puede no tener anexos y publicar su cuadro como imágenes
 * dentro del propio aviso —el Decreto 584/2024, que fija las tasas
 * migratorias, hace exactamente eso—: para ese caso está `imagenesDelAviso`.
 */

const zlib = require('zlib');
const https = require('https');

const BASE = 'https://www.boletinoficial.gob.ar';

// ---------------------------------------------------------------- HTTP

function pedir(url, opciones = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opciones, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(pedir(new URL(res.headers.location, url).href, opciones));
      }
      const trozos = [];
      res.on('data', (c) => trozos.push(c));
      res.on('end', () => {
        const cuerpo = Buffer.concat(trozos);
        if (res.statusCode !== 200) {
          return reject(new Error(`${url} respondió ${res.statusCode}`));
        }
        resolve(cuerpo);
      });
    });
    req.on('error', reject);
    if (opciones.body) req.write(opciones.body);
    req.end();
  });
}

// ------------------------------------------------------------ descubrir

/**
 * Lee la página de un aviso y devuelve los parámetros de sus anexos.
 *
 * En el HTML los anexos aparecen como
 *   descargarPDFAnexo("primera","1", "7756246", "20260901", "/pdf/download_anexo")
 * Nada de eso es un enlace: son argumentos de una llamada.
 *
 * @param {string} url  URL del aviso, por ejemplo
 *   https://www.boletinoficial.gob.ar/detalleAviso/primera/346684/20260901
 * @returns {Promise<{seccion:string,idAnexo:string,fecha:string,cantidad:number,titulo:string}>}
 */
async function descubrir(url) {
  const html = (await pedir(url)).toString('utf8');

  const llamadas = [...html.matchAll(/descargarPDFAnexo\(([^)]*)\)/g)].map((m) =>
    // El HTML llega con las comillas escapadas como &quot;
    m[1].replace(/&quot;/g, '"').split(',').map((x) => x.trim().replace(/^"|"$/g, ''))
  );

  if (!llamadas.length) {
    throw new Error(
      'La página no declara anexos. Puede que la norma no tenga, o que su ' +
        'contenido esté en el cuerpo del aviso.'
    );
  }

  const [seccion, , idAnexo, fecha] = llamadas[0];
  const titulo = (html.match(/<title>([^<]*)<\/title>/) || [, ''])[1].trim();

  return { seccion, idAnexo, fecha, cantidad: llamadas.length, titulo };
}

/**
 * Las imágenes que el aviso incrusta en su propio cuerpo.
 *
 * Es el otro modo en que una norma esconde sus números, y no tiene nada que ver
 * con los anexos. El Decreto 584/2024, que fija las tasas migratorias, no
 * declara ningún anexo: su cuadro de tasas está publicado como cuatro imágenes
 * dentro del aviso. `descubrir` ahí falla con razón, y esto es lo que hay que
 * mirar en su lugar.
 *
 * Devuelve URLs descargables. Leerlas ya es problema de quien mire —acá no hay
 * OCR—, pero al menos se sabe dónde está el dato en vez de concluir que no
 * existe.
 *
 * @param {string} url  URL del aviso
 * @returns {Promise<string[]>}
 */
async function imagenesDelAviso(url) {
  const html = (await pedir(url)).toString('utf8');
  const encontradas = [...html.matchAll(/src="([^"]*\/imagenes\/getImagen\/[^"]+)"/g)].map((m) =>
    new URL(m[1].replace(/&amp;/g, '&'), BASE).href
  );
  return [...new Set(encontradas)];
}

/**
 * Descarga un anexo. Devuelve el PDF como Buffer.
 *
 * @param {object} p  {seccion, nroAnexo, idAnexo, fecha}
 */
async function descargarAnexo({ seccion = 'primera', nroAnexo, idAnexo, fecha }) {
  const body = new URLSearchParams({
    seccion,
    nroAnexo: String(nroAnexo),
    idAnexo: String(idAnexo),
    fechaPublicacion: String(fecha),
  }).toString();

  const respuesta = await pedir(`${BASE}/pdf/download_anexo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  const json = JSON.parse(respuesta.toString('utf8'));
  if (!json.pdfBase64) {
    throw new Error(`El anexo ${nroAnexo} no devolvió PDF. ¿Existe ese número?`);
  }
  return Buffer.from(json.pdfBase64, 'base64');
}

// --------------------------------------------------------------- PDF

function indexarObjetos(buf) {
  const raw = buf.toString('latin1');
  const objs = {};
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const inicio = m.index + m[0].length;
    const fin = raw.indexOf('endobj', inicio);
    if (fin < 0) continue;
    const cuerpo = raw.slice(inicio, fin);
    const si = cuerpo.indexOf('stream');
    let dict = cuerpo;
    let data = null;
    if (si >= 0) {
      dict = cuerpo.slice(0, si);
      let s = si + 6;
      if (cuerpo[s] === '\r') s++;
      if (cuerpo[s] === '\n') s++;
      let trozo = buf.slice(inicio + s, inicio + cuerpo.indexOf('endstream', s));
      if (/\/FlateDecode/.test(dict)) {
        for (const f of [zlib.inflateSync, zlib.inflateRawSync]) {
          try { trozo = f(trozo); break; } catch (e) { /* probamos el otro */ }
        }
      }
      data = trozo;
    }
    objs[m[1]] = { dict, data };
  }
  return objs;
}

/** Parsea un CMap de /ToUnicode: código de glifo -> carácter real. */
function parsearCMap(txt) {
  const map = {};
  const uni = (h) => {
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16));
    return s;
  };
  let m;
  const chars = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = chars.exec(txt))) {
    const pares = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pares.exec(m[1]))) map[parseInt(p[1], 16)] = uni(p[2]);
  }
  const rangos = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangos.exec(txt))) {
    const tri = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = tri.exec(m[1]))) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const base = parseInt(p[3].substr(0, 4), 16);
      for (let c = lo; c <= hi && c - lo < 512; c++) map[c] = String.fromCharCode(base + (c - lo));
    }
  }
  return map;
}

const NOMBRADOS = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/**
 * Decodifica una cadena PDF.
 *
 * En una sola pasada, y esto importa: los códigos de glifo 8 a 13 vienen
 * escapados como \b \t \n \f \r, y si se los trata en una pasada aparte se
 * pierden dígitos sueltos dentro de los importes. `$ 501.537` salía
 * `$ 501.53`, que es peor que un error visible.
 */
function decodificar(token) {
  if (token[0] === '<') {
    const h = token.slice(1, -1).replace(/\s/g, '');
    let s = '';
    for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.substr(i, 2), 16));
    return s;
  }
  return token.slice(1, -1).replace(/\\([nrtbf()\\]|\d{1,3})/g, (a, c) => {
    if (NOMBRADOS[c] !== undefined) return NOMBRADOS[c];
    if (c === '(' || c === ')' || c === '\\') return c;
    return String.fromCharCode(parseInt(c, 8));
  });
}

const TOKENS =
  /\/([A-Za-z0-9#+._-]+)\s+[\d.]+\s+Tf|(\((?:[^()\\]|\\[\s\S])*\))|(<[0-9A-Fa-f\s]*>)|\b(Td|TD|T\*|ET|BT)\b/g;

/**
 * Extrae el texto de un PDF del Boletín Oficial.
 *
 * @param {Buffer} pdf
 * @returns {string}
 */
function extraerTexto(pdf) {
  const objs = indexarObjetos(pdf);

  const fuentes = {};
  for (const [num, o] of Object.entries(objs)) {
    if (!/\/Type\s*\/Font/.test(o.dict)) continue;
    const tu = o.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    fuentes[num] =
      tu && objs[tu[1]] && objs[tu[1]].data
        ? parsearCMap(objs[tu[1]].data.toString('latin1'))
        : null;
  }

  // Nombre de recurso (/F1) -> objeto de la fuente. El diccionario /Font puede
  // estar embebido o ser una referencia indirecta; hay que mirar las dos.
  const recursos = {};
  const cosechar = (txt) => {
    const re = /\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g;
    let m;
    while ((m = re.exec(txt))) if (fuentes[m[2]] !== undefined) recursos[m[1]] = m[2];
  };
  for (const o of Object.values(objs)) {
    const embebido = o.dict.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (embebido) cosechar(embebido[1]);
    const ref = o.dict.match(/\/Font\s+(\d+)\s+\d+\s+R/);
    if (ref && objs[ref[1]]) cosechar(objs[ref[1]].dict);
  }

  const lineas = [];
  for (const o of Object.values(objs)) {
    if (!o.data) continue;
    const c = o.data.toString('latin1');
    if (!/TJ|Tj/.test(c)) continue;

    let map = null;
    let actual = '';
    const cortar = () => {
      if (actual.trim()) lineas.push(actual.replace(/\s+/g, ' ').trim());
      actual = '';
    };

    TOKENS.lastIndex = 0;
    let m;
    while ((m = TOKENS.exec(c))) {
      if (m[1] !== undefined) {
        map = recursos[m[1]] !== undefined ? fuentes[recursos[m[1]]] : null;
      } else if (m[2] !== undefined || m[3] !== undefined) {
        const bytes = decodificar(m[2] !== undefined ? m[2] : m[3]);
        if (map) {
          for (let i = 0; i < bytes.length; i++) {
            const ch = map[bytes.charCodeAt(i)];
            if (ch !== undefined) actual += ch;
          }
        } else {
          actual += bytes;
        }
      } else {
        cortar();
      }
    }
    cortar();
  }
  return lineas.join('\n');
}

/**
 * Mira un PDF y dice qué se puede esperar de él.
 *
 * Sirve para no confundir "el anexo está vacío" con "el anexo son imágenes".
 * Esa distinción es la diferencia entre publicar un dato inexistente y saber
 * que hay que leer el cuadro a mano.
 */
function analizar(pdf) {
  const texto = extraerTexto(pdf);
  const raw = pdf.toString('latin1');
  const imagenes = (raw.match(/\/Subtype\s*\/Image/g) || []).length;
  // La portada del sistema GEDO ("Hoja Adicional de Firmas") siempre trae
  // texto, así que un anexo escaneado igual devuelve algo. Ese piso es el que
  // hay que descontar antes de decir que hay contenido.
  const utiles = texto.split('\n').filter((l) => l.length > 3).length;
  return {
    texto,
    lineas: utiles,
    imagenes,
    esProbablementeImagen: utiles < 40 && imagenes > 0,
  };
}

/**
 * Todo junto: de una URL de aviso a los anexos transcritos.
 *
 * @param {string} url
 * @param {{numero?: number}} opciones
 */
async function leerAviso(url, opciones = {}) {
  const info = await descubrir(url);
  const numeros = opciones.numero
    ? [opciones.numero]
    : Array.from({ length: info.cantidad }, (_, i) => i + 1);

  const anexos = [];
  for (const nroAnexo of numeros) {
    const pdf = await descargarAnexo({ ...info, nroAnexo });
    anexos.push({ numero: nroAnexo, pdf, ...analizar(pdf) });
  }
  return { ...info, anexos };
}

module.exports = { descubrir, imagenesDelAviso, descargarAnexo, extraerTexto, analizar, leerAviso };
