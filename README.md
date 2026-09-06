# bora-anexos

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22546926.svg)](https://doi.org/10.5281/zenodo.22546926)
[![MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)

Descarga y transcribe los **anexos del Boletín Oficial de la República Argentina**.

```bash
npx bora-anexos https://www.boletinoficial.gob.ar/detalleAviso/primera/346684/20260901
```

```
BOLETIN OFICIAL REPUBLICA ARGENTINA - ANSES - Resolución 260/2026
  anexo 1: 161 KB, 84 líneas de texto
  anexo 2: 137 KB, 79 líneas de texto
  ...
```

Sin dependencias. Node 18 o superior.

---

## El problema

Muchas normas argentinas ponen lo importante en los anexos: los montos de una
resolución de ANSES, el cuadro de tasas de un decreto, el cronograma de pagos de
todo un año. Y los anexos **no se pueden enlazar**.

En la página del aviso no son enlaces sino llamadas JavaScript:

```html
descargarPDFAnexo("primera","1", "7756246", "20260901", "/pdf/download_anexo")
```

Eso hace un `POST` y recibe el PDF codificado en base64. No hay URL que copiar,
no hay `href` que seguir, y un scraper que busque enlaces no encuentra nada.

Cuando el PDF ya está descargado, todavía falta la mitad. Los PDF que produce el
sistema GEDO usan fuentes subseteadas con codificación propia: leer los streams
y sacar las cadenas entre paréntesis devuelve basura como `#$%%`. Hay que pasar
cada byte por el CMap de `/ToUnicode` de la fuente que esté activa en ese punto
del content stream, lo que obliga a seguir los operadores `Tf`.

Esta herramienta hace las dos cosas.

## Uso

```
bora-anexos <url del aviso> [opciones]

  -o, --out <dir>   dónde escribir (por defecto: el directorio actual)
  -n, --num <n>     sólo ese anexo
      --solo-texto  no guardar los PDF
      --solo-pdf    no transcribir
      --json        volcar a stdout como JSON
      --listar      cuántos anexos hay
      --imagenes    imágenes incrustadas en el cuerpo del aviso
```

Ejemplos:

```bash
# Sólo el anexo con los montos de la AUH
bora-anexos https://www.boletinoficial.gob.ar/detalleAviso/primera/346684/20260901 -n 5

# Encadenado con otra cosa
bora-anexos <url> --json | jq -r '.anexos[].texto'
```

Como biblioteca:

```js
const { leerAviso } = require('bora-anexos');

const aviso = await leerAviso('https://www.boletinoficial.gob.ar/detalleAviso/primera/346684/20260901');
for (const a of aviso.anexos) {
  console.log(a.numero, a.texto.slice(0, 200));
}
```

| Función | Qué hace |
|---|---|
| `descubrir(url)` | parámetros de los anexos de un aviso |
| `descargarAnexo({seccion, nroAnexo, idAnexo, fecha})` | el PDF, como Buffer |
| `extraerTexto(pdf)` | el texto, resolviendo las fuentes |
| `analizar(pdf)` | texto + si parece escaneado |
| `leerAviso(url, {numero})` | todo junto |
| `imagenesDelAviso(url)` | imágenes del cuerpo del aviso |

## Los dos modos de que un número quede fuera de alcance

Conviene no confundirlos, porque llevan a lugares distintos.

**El anexo viene escaneado.** Pasa. `analizar` devuelve `esProbablementeImagen`
y el CLI lo dice, en vez de entregar un texto vacío que se leería como «el anexo
está en blanco». No hay OCR acá: la herramienta avisa dónde hay que mirar a
mano.

**La norma no tiene anexos y publica su cuadro como imágenes dentro del aviso.**
El [Decreto 584/2024](https://www.boletinoficial.gob.ar/detalleAviso/primera/310125/20240705),
que fija las tasas migratorias, es el caso típico: sus cuatro cuadros de tasas
son imágenes en el cuerpo. Ahí `descubrir` falla con razón y lo que sirve es:

```bash
bora-anexos https://www.boletinoficial.gob.ar/detalleAviso/primera/310125/20240705 --imagenes
```

## Detalles que costaron tiempo

Están en el código, pero vale dejarlos acá por si alguien reimplementa esto:

- **Los escapes con nombre hay que resolverlos en la misma pasada que los
  octales.** Los códigos de glifo 8 a 13 viajan como `\b \t \n \f \r`. Tratarlos
  aparte hace desaparecer dígitos sueltos dentro de los importes: `$ 501.537`
  salía `$ 501.53`. Un error que no se nota es peor que uno que rompe.
- **El diccionario `/Font` puede ser una referencia indirecta** (`/Font 5 0 R`),
  no sólo un diccionario embebido. Si sólo se mira el caso embebido, las fuentes
  no se resuelven y vuelve la basura.
- **Los streams pueden estar en `deflate` o en `deflate-raw`.** Hay que probar
  los dos.
- **La portada del sistema GEDO siempre trae texto.** O sea que un anexo
  escaneado igual devuelve algunas líneas: por eso `analizar` compara contra un
  piso en vez de contra cero.

## Origen

Salió de mantener [turnosytramites.com](https://turnosytramites.com), un sitio de
guías de trámites que publica los montos del Estado argentino con la norma que
fija cada cifra. Los datos, y las series mensuales que se arman con esto, están
depositados con DOI: <https://doi.org/10.5281/zenodo.22544071>.

## Cómo citar

Si lo usás en un trabajo, el DOI apunta siempre a la última versión:



## Licencia

MIT.

Esto lee información pública del Boletín Oficial, que es de acceso libre. Usalo
con la misma cortesía que cualquier sitio ajeno: no lo martilles.
