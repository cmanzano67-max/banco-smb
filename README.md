# Banco de situaciones SMB · versión web

App del cuerpo técnico de hockey del CHP Santa María la Blanca: banco de ejercicios, sesiones con la plantilla del club, liga del vestuario y panel de la Dirección Técnica.

## Cómo está hecho

- **Una sola plantilla** (`src/template.html`) genera las dos versiones:
  - `build.py` → el artifact de claude.ai (banco en `data/banco.json`, votos en la base de datos del artifact).
  - `build_web.py` → esta web (GitHub Pages + Firebase).
- **`cloud.js`** es la capa web. Le da a la app lo mismo que le daba claude.ai (`window.claude.use('artifact' | 'user' | 'db' | 'downloads')`) pero con Firebase por debajo:
  - Cuentas: Firebase Authentication (Google y email con contraseña).
  - Datos: Cloud Firestore. Cada objeto se guarda como texto JSON en el campo `j` (Firestore no admite listas dentro de listas).
  - Acceso: quien crea cuenta queda «esperando»; la DT le da acceso desde Dirección Técnica → Cuerpo técnico.
  - «Mandar a la DT» escribe en `inbox/`; la DT lo ve en la Bandeja («Recibido»).
- **El banco no está en este repositorio.** Vive en Firestore y solo lo leen las cuentas con acceso. `index.html` lleva un banco vacío.

## Datos en Firestore

| Ruta | Qué | Quién lee | Quién escribe |
|---|---|---|---|
| `club/state` | votación abierta, cuerpo técnico, accesos (`memberUids`, `dtUids`) | con acceso | DT |
| `tasks/{id}` | ejercicios del banco (`j`, orden `o`) | con acceso | DT |
| `historial/{id}`, `liga/j{n}` | elegidos de cada semana, jornadas | con acceso | DT |
| `profiles/{uid}` | nombre, email, personaje y poder | con acceso y el dueño | el dueño |
| `users/{uid}/mine/{id}`, `/sessions/{id}`, `/meta/state` | lo de cada entrenador | el dueño | el dueño |
| `votes/{uid}` | voto de la semana | con acceso | el dueño |
| `inbox/{id}` | lo mandado a la DT | DT y quien lo mandó | crea quien tiene acceso; DT marca «hecho» |

Reglas en `firestore.rules`. `DT_UID` se sustituye por el código de usuario de la DT (también en `firebase-config.js`).

## Publicar un cambio

1. Cambiar `src/template.html` (o `cloud.js`).
2. `python3 build_web.py dist/` y probar con `t6/web_test.py` (backend simulado `fakefb.js`, mismas reglas que Firestore).
3. Subir a `pruebas/` para revisarlo en el móvil; cuando la DT dé el visto bueno, a la raíz. GitHub Pages publica en uno o dos minutos.
4. `sw.js` lleva la versión en el nombre de la caché: cada build nuevo se actualiza solo en los móviles.

## Instalar en el móvil

- Android (Chrome): menú ⋮ → «Instalar aplicación» o «Añadir a pantalla de inicio».
- iPhone (Safari): botón Compartir → «Añadir a pantalla de inicio». Hay que entrar con la cuenta dentro de la app instalada.

## Créditos

Personajes: Avataaars de Pablo Stanley (uso libre) con DiceBear (MIT). Ejercicios y gráficos del libro de Marc Oller, *365 exercicis d'hoquei patins*: solo para uso interno del club, por eso no están en el repositorio.
