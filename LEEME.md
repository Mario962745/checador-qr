# Checador QR: registro electrónico de jornada

Aplicación web para llevar el registro electrónico de la jornada que exige el **art. 132, fracción XXXIV de la Ley Federal del Trabajo** (reforma publicada en el DOF el 1 de mayo de 2026; las disposiciones generales aplican a partir del **1 de enero de 2027**).

> **Aviso:** esta herramienta ayuda a cumplir con la obligación, pero no sustituye la asesoría legal. La STPS va a publicar disposiciones de carácter general (alcance, excepciones y requisitos técnicos). Cuando salgan, revise que el sistema cumpla con ellas.

## Cómo funciona

1. **Kiosco:** en la entrada del centro de trabajo se pone una tableta, monitor o computadora con la pantalla del kiosco. Muestra un **código QR que cambia cada 30 segundos** y la hora oficial del servidor.
2. **Celular de la persona trabajadora:** escanea el QR con la cámara (no hay que instalar nada). La primera vez ingresa su **número de empleado y NIP**, y el celular queda vinculado. Las siguientes veces solo toca **"Registrar entrada"** o **"Registrar salida"**.
3. **Comprobante:** en pantalla aparecen la hora registrada, un folio y un sello. Cada persona puede consultar sus registros de los últimos 31 días desde su celular.
4. **Administración** (`/admin`): personal en tiempo real, jornadas con horas trabajadas, registros, correcciones, altas y bajas, kioscos, verificación de integridad y bitácora. Todo se puede exportar a CSV (se abre en Excel).

## Cómo cubre lo que pide la ley

| Requisito | Cómo se cumple |
|---|---|
| Registro electrónico | Base de datos SQLite en el servidor |
| Hora de entrada y salida | Siempre se toma la hora del **servidor** (zona `America/Mexico_City`), nunca la del celular |
| Horas trabajadas | Se calculan juntando cada entrada con su salida, incluidos los turnos que cruzan la medianoche |
| Identificación de quién registra | Cada registro guarda `empleado:<número>` o `admin:<usuario>`, el kiosco, el celular, la IP y, si la persona lo permite, la ubicación |
| Entregar la información a la autoridad | Exportación CSV de jornadas (con RFC y CURP) y de registros (con sellos) |
| Que no se pueda alterar | Los registros **no se pueden editar ni borrar**: lo impiden triggers en la base de datos. Para corregir se **agrega** un registro o se **anula** uno, y siempre queda el motivo y quién lo hizo. Cada registro lleva un sello SHA-256 encadenado con el anterior, y la pestaña "Integridad" detecta cualquier alteración |

**Controles contra el registro desde fuera del centro de trabajo:** el QR cambia cada 30 s, cada escaneo da un pase que dura 5 minutos y sirve una sola vez, solo puede haber un celular activo por persona, y se bloquean los registros duplicados.

## Instalación

Requisito: **Node.js 22.13 o más nuevo** (se recomienda 24 LTS). No usa librerías externas, así que no hace falta `npm install`.

```powershell
node server.js
```

Abra `http://localhost:3000/admin`. Usuario inicial: **admin** / **cambiar123**. **Cámbielo de inmediato** en la pestaña "Cuenta".

### Variables de entorno (opcionales)

| Variable | Default | Uso |
|---|---|---|
| `PORT` | 3000 | Puerto |
| `EMPRESA` | Mi Empresa S.A. de C.V. | Nombre que aparece en las pantallas |
| `TZ_EMPRESA` | America/Mexico_City | Zona horaria (p. ej. `America/Tijuana`, `America/Cancun`) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / cambiar123 | Administrador inicial (solo se usa en el primer arranque) |
| `DB_PATH` | ./datos/checador.db | Ubicación de la base de datos |

### Puesta en producción

Para que los celulares entren desde su propia red, el servidor tiene que estar en internet con **HTTPS**. Opciones:
- Un VPS (DigitalOcean, AWS Lightsail, etc.) con Caddy o Nginx como proxy HTTPS.
- Render, Railway o Fly.io con **disco persistente** montado en la carpeta `datos/`.
- Un servidor en la oficina publicado con Cloudflare Tunnel.

Si el servidor está detrás de un proxy, este debe enviar `X-Forwarded-Proto: https`.

**Respaldos:** copie con frecuencia la carpeta `datos/`. La ley pide poder entregar la información cuando la autoridad la solicite, así que conviene guardar varios años (como referencia, la LFT pide conservar los documentos laborales durante 1 año después de terminada la relación, y el SAT y el IMSS piden 5 años).

## Primeros pasos

1. Entre a `/admin` y cambie la contraseña.
2. En **Kioscos**, cree uno (por ejemplo "Entrada principal") y abra su enlace en la tableta de la entrada (botón "Pantalla completa").
3. En **Empleados**, dé de alta a cada persona con un NIP inicial y entréguele su número y NIP en privado.
4. Listo: cada persona escanea el QR al llegar y al salir.

## Recomendaciones legales

- **Firme un acuerdo con el personal** (o inclúyalo en el contrato o en el reglamento interior de trabajo) sobre el uso de este sistema. La reforma da valor probatorio pleno al registro cuando fue acordado por ambas partes.
- **Aviso de privacidad:** el sistema guarda datos personales (nombre, RFC, CURP, IP y ubicación opcional). Actualice su aviso de privacidad conforme a la LFPDPPP.
- Revise las disposiciones que publique la STPS antes del 1 de enero de 2027.

## Estructura

```
server.js            Servidor, API y base de datos (Node.js, sin dependencias)
public/kiosco.html   Pantalla con QR rotativo
public/registro.html Pantalla del celular
public/admin.html    Panel de administración
public/estilos.css   Estilos
datos/               Base de datos (se crea sola, NO se debe borrar)
```

El kiosco carga la librería para dibujar el QR desde `cdn.jsdelivr.net`, así que la tableta necesita internet.
