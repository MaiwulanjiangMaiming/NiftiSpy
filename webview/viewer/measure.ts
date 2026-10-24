export type Axis = 'axial' | 'coronal' | 'sagittal';

interface LineMeasurement { type: 'line'; axis: Axis; x1: number; y1: number; x2: number; y2: number; distance: number; }
interface RoiMeasurement { type: 'roi'; axis: Axis; x1: number; y1: number; x2: number; y2: number; area: number; }
export type Measurement = LineMeasurement | RoiMeasurement;
export function drawMeasurements(measurements: Measurement[], highContrast: boolean): void {
  for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
    const measureCanvas = document.getElementById(`measure-${axis}`) as HTMLCanvasElement;
    if (!measureCanvas) continue;
    const container = measureCanvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    measureCanvas.width = container.clientWidth * dpr;
    measureCanvas.height = container.clientHeight * dpr;
    measureCanvas.style.width = container.clientWidth + 'px';
    measureCanvas.style.height = container.clientHeight + 'px';
    const ctx = measureCanvas.getContext('2d');
    if (!ctx) continue;
    ctx.clearRect(0, 0, measureCanvas.width, measureCanvas.height);
    ctx.scale(dpr, dpr);
    const axisMeasurements = measurements.filter(m => m.axis === axis);
    for (const m of axisMeasurements) {
      if (m.type === 'line') {
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = highContrast ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(m.x1, m.y1);
        ctx.lineTo(m.x2, m.y2);
        ctx.stroke();
        // Distance label at midpoint
        const mx = (m.x1 + m.x2) / 2;
        const my = (m.y1 + m.y2) / 2;
        ctx.font = highContrast ? 'bold 13px sans-serif' : '11px sans-serif';
        ctx.fillStyle = '#00ff00';
        ctx.textAlign = 'center';
        ctx.fillText(`${m.distance.toFixed(2)} mm`, mx, my - 6);
      } else {
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = highContrast ? 3 : 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
        ctx.setLineDash([]);
        const rx = (m.x1 + m.x2) / 2;
        const ry = (m.y1 + m.y2) / 2;
        ctx.font = highContrast ? 'bold 13px sans-serif' : '11px sans-serif';
        ctx.fillStyle = '#ffff00';
        ctx.textAlign = 'center';
        ctx.fillText(`${m.area.toFixed(2)} mm²`, rx, ry - 6);
      }
    }
  }
}

