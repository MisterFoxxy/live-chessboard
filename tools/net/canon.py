"""Канонический снимок фигуры: где камера над доской и как вырезать клетку так, чтобы фигура всегда «лежала» вверх.
Фигура стоит вертикально, поэтому на выпрямленной доске она вытянута от точки под камерой (надира) наружу. Повернув вырез
вдоль этого луча, получаем вид, который зависит только от расстояния до надира, а не от клетки."""
import numpy as np, cv2
from fitlib import dlt

def camera(quad, W, H):
    """quad — углы поля в пикселях кадра (по порядку: лев-верх, прав-верх, прав-низ, лев-низ выпрямленной доски).
    Возвращает (nx, ny, h): надир и высоту камеры в клетках, в координатах выпрямленной доски (0..8)."""
    Hm = dlt([(0, 0), (8, 0), (8, 8), (0, 8)], quad)
    Hm = np.array([[1, 0, -W / 2], [0, 1, -H / 2], [0, 0, 1]]) @ Hm            # главная точка — центр кадра
    h1, h2, h3 = Hm[:, 0], Hm[:, 1], Hm[:, 2]
    den = h1[2] * h2[2]
    f2 = -(h1[0] * h2[0] + h1[1] * h2[1]) / den if abs(den) > 1e-12 else -1
    if not (f2 > (0.4 * max(W, H)) ** 2 and f2 < (4 * max(W, H)) ** 2): f2 = (0.9 * max(W, H)) ** 2   # камера почти сверху — берём обычный угол обзора телефона
    Ki = np.diag([1 / np.sqrt(f2), 1 / np.sqrt(f2), 1])
    a, b, t = Ki @ h1, Ki @ h2, Ki @ h3
    lam = (np.linalg.norm(a) + np.linalg.norm(b)) / 2
    a, b, t = a / lam, b / lam, t / lam
    if t[2] < 0: a, b, t = -a, -b, -t
    R = np.stack([a, b, np.cross(a, b)], 1)
    U, _, Vt = np.linalg.svd(R); R = U @ Vt
    C = -R.T @ t
    return float(C[0]), float(C[1]), float(abs(C[2]))

def crops64(w, S, cells, nadir, out=64):
    """w — выпрямленная доска с полем в 1 клетку (S пикселей на клетку); cells — список (r, c) в координатах кадра.
    Вырез: 1,5 клетки поперёк луча, от −0,6 до +1,7 клетки вдоль (в сторону от камеры), растянут в out×out, верх — «от камеры»."""
    nx, ny = (nadir[0] + 1) * S, (nadir[1] + 1) * S
    res = np.empty((len(cells), out, out, 3), np.uint8)
    for i, (r, c) in enumerate(cells):
        px, py = (c + 1.5) * S, (r + 1.5) * S
        ux, uy = px - nx, py - ny; d = np.hypot(ux, uy)
        if d < 0.5 * S: ux, uy = 0.0, -1.0
        else: ux, uy = ux / d, uy / d
        ex, ey = -uy, ux                                                        # поперёк луча
        ka = 1.5 * S / out; kb = 2.3 * S / out
        # src = p + e·(ox − out/2)·ka + u·(1.7·S − oy·kb)
        A = np.float32([[ex * ka, -ux * kb, px - ex * ka * out / 2 + ux * 1.7 * S],
                        [ey * ka, -uy * kb, py - ey * ka * out / 2 + uy * 1.7 * S]])
        res[i] = cv2.warpAffine(w, A, (out, out), flags=cv2.INTER_AREA | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return res
