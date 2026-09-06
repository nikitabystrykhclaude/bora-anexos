#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { leerAviso, descubrir, imagenesDelAviso } = require('../index.js');

const AYUDA = `
bora-anexos — descarga y transcribe los anexos del Boletín Oficial argentino

  bora-anexos <url del aviso> [opciones]

Opciones
  -o, --out <dir>   dónde escribir los archivos (por defecto: el directorio actual)
  -n, --num <n>     sólo ese anexo, en vez de todos
      --solo-texto  no guardar los PDF, sólo los .txt
      --solo-pdf    no transcribir, sólo guardar los PDF
      --json        volcar todo a stdout como JSON, sin escribir archivos
      --listar      decir cuántos anexos hay y salir
      --imagenes    listar las imágenes incrustadas en el cuerpo del aviso
  -h, --help        esto

Ejemplos
  # Los siete anexos de una resolución de ANSES
  bora-anexos https://www.boletinoficial.gob.ar/detalleAviso/primera/346684/20260901

  # Sólo el quinto, que es donde están los montos de la AUH
  bora-anexos https://www.boletinoficial.gob.ar/detalleAviso/primera/346684/20260901 -n 5

  # Para pasarle el texto a otro programa
  bora-anexos <url> --json | jq -r '.anexos[].texto'

Por qué hace falta esto
  En la página del aviso los anexos no son enlaces: son llamadas JavaScript que
  hacen un POST y reciben el PDF en base64. Y esos PDF usan fuentes con
  codificación propia, así que leerlos sin traducir los CMap devuelve basura.

Cuando la norma no tiene anexos
  Algunas publican sus cuadros como imágenes dentro del propio aviso. El Decreto
  584/2024, que fija las tasas migratorias, es el caso típico. Ahí --imagenes
  devuelve las URLs de esas imágenes.

Lo que no hace
  OCR. Si un anexo viene escaneado, lo dice en vez de devolver un texto vacío.
`;

function parsear(argv) {
  const o = { url: null, out: '.', num: null, soloTexto: false, soloPdf: false, json: false, listar: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { ayuda: true };
    else if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '-n' || a === '--num') o.num = Number(argv[++i]);
    else if (a === '--solo-texto') o.soloTexto = true;
    else if (a === '--solo-pdf') o.soloPdf = true;
    else if (a === '--json') o.json = true;
    else if (a === '--listar') o.listar = true;
    else if (a === '--imagenes') o.imagenes = true;
    else if (!a.startsWith('-')) o.url = a;
  }
  return o;
}

async function main() {
  const o = parsear(process.argv.slice(2));
  if (o.ayuda || !o.url) {
    console.log(AYUDA);
    process.exit(o.url ? 0 : 1);
  }
  if (!/^https?:\/\/(www\.)?boletinoficial\.gob\.ar\//.test(o.url)) {
    console.error('Se espera una URL de boletinoficial.gob.ar, del tipo');
    console.error('  https://www.boletinoficial.gob.ar/detalleAviso/primera/346684/20260901');
    process.exit(1);
  }

  if (o.imagenes) {
    const urls = await imagenesDelAviso(o.url);
    if (!urls.length) return console.log('El aviso no incrusta imágenes.');
    console.log(`${urls.length} imagen(es) en el cuerpo del aviso:`);
    urls.forEach((u) => console.log('  ' + u));
    return;
  }

  if (o.listar) {
    const info = await descubrir(o.url);
    console.log(`${info.titulo}`);
    console.log(`${info.cantidad} anexo(s) — idAnexo ${info.idAnexo}, sección ${info.seccion}, ${info.fecha}`);
    return;
  }

  const aviso = await leerAviso(o.url, o.num ? { numero: o.num } : {});

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          titulo: aviso.titulo,
          idAnexo: aviso.idAnexo,
          fecha: aviso.fecha,
          anexos: aviso.anexos.map((a) => ({
            numero: a.numero,
            lineas: a.lineas,
            imagenes: a.imagenes,
            esProbablementeImagen: a.esProbablementeImagen,
            texto: a.texto,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  fs.mkdirSync(o.out, { recursive: true });
  console.log(aviso.titulo);

  for (const a of aviso.anexos) {
    const base = path.join(o.out, `anexo_${a.numero}`);
    if (!o.soloTexto) fs.writeFileSync(`${base}.pdf`, a.pdf);
    if (!o.soloPdf) fs.writeFileSync(`${base}.txt`, a.texto, 'utf-8');

    const kb = (a.pdf.length / 1024).toFixed(0);
    let nota = `${a.lineas} líneas de texto`;
    if (a.esProbablementeImagen) {
      nota = `sólo ${a.lineas} líneas y ${a.imagenes} imágenes — el cuadro probablemente esté escaneado, hay que mirarlo`;
    }
    console.log(`  anexo ${a.numero}: ${kb} KB, ${nota}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
