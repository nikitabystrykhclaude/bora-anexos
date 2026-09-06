#!/usr/bin/env node
'use strict';
/*
 * Prueba de humo contra avisos reales.
 *
 * Usa la red a propósito: lo que puede romperse acá no es la aritmética sino el
 * Boletín Oficial —que cambie el nombre de la función, el endpoint o el formato
 * de los PDF—, y eso sólo se detecta yendo. Los dos avisos elegidos cubren los
 * dos caminos: uno con anexos que transcriben, otro sin anexos y con el cuadro
 * publicado como imágenes.
 *
 *   node prueba.js
 */

const { descubrir, leerAviso, imagenesDelAviso } = require('./index.js');

const CON_ANEXOS = 'https://www.boletinoficial.gob.ar/detalleAviso/primera/346684/20260901';
const CON_IMAGENES = 'https://www.boletinoficial.gob.ar/detalleAviso/primera/310125/20240705';

let fallos = 0;

function comprobar(descripcion, condicion, detalle) {
  if (condicion) {
    console.log(`  ok    ${descripcion}`);
  } else {
    console.log(`  FALLA ${descripcion}${detalle ? ' — ' + detalle : ''}`);
    fallos++;
  }
}

async function main() {
  console.log('Resolución ANSES 260/2026 (siete anexos con montos)');
  const info = await descubrir(CON_ANEXOS);
  comprobar('descubre los anexos', info.cantidad === 7, `encontró ${info.cantidad}`);
  comprobar('saca el idAnexo', info.idAnexo === '7756246', info.idAnexo);

  const aviso = await leerAviso(CON_ANEXOS, { numero: 5 });
  const texto = aviso.anexos[0].texto;
  comprobar('el anexo V transcribe', texto.length > 500, `${texto.length} caracteres`);
  comprobar(
    'los importes salen enteros',
    texto.includes('$ 154.031') && texto.includes('$ 501.537'),
    'faltan los montos de la AUH; probablemente se perdieron dígitos en los escapes'
  );
  comprobar(
    'no quedó basura de fuentes sin resolver',
    !/#\$%%/.test(texto),
    'aparece el patrón típico de un CMap no aplicado'
  );

  console.log('\nDecreto 584/2024 (sin anexos, cuadros como imágenes)');
  // El mensaje se guarda y se muestra si falla. Sin eso, un tropiezo de red se
  // ve igual que un parser roto, y son cosas muy distintas.
  let mensaje = '(no lanzó)';
  try {
    await descubrir(CON_IMAGENES);
  } catch (e) {
    mensaje = e.message;
  }
  comprobar('avisa que no hay anexos', /no declara anexos/.test(mensaje), mensaje);

  const imagenes = await imagenesDelAviso(CON_IMAGENES);
  comprobar('encuentra las imágenes del cuerpo', imagenes.length === 4, `encontró ${imagenes.length}`);

  console.log(fallos ? `\n${fallos} falla(s)` : '\nTodo en orden.');
  process.exit(fallos ? 1 : 0);
}

main().catch((e) => {
  console.error('La prueba no pudo correr:', e.message);
  process.exit(1);
});
