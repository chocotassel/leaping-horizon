import { useEffect, useRef, useState } from 'react';
import { GameController } from '../game/GameController';
import { type GameResult, type Level } from '../types';

interface GameScreenProps {
  level: Level;
  onDeath: (result: GameResult) => void;
  onFinish: (result: GameResult) => void;
}

export function GameScreen({ level, onDeath, onFinish }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const [hud, setHud] = useState({ score: 0, combo: 0, progress: 0 });
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!canvasRef.current || !stageRef.current) return;
    const controller = new GameController(canvasRef.current, level, {
      onHud: (score, combo, progress) => setHud({ score, combo, progress }),
      onDeath: (result) => {
        setPaused(false);
        onDeath(result);
      },
      onFinish,
    });
    controllerRef.current = controller;

    const resize = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect) controller.resize(rect.width, rect.height);
    };
    resize();
    window.addEventListener('resize', resize);
    controller.start();
    return () => {
      window.removeEventListener('resize', resize);
      controller.destroy();
      controllerRef.current = null;
    };
  }, [level, onDeath, onFinish]);

  const normalizePointer = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return ((clientX - rect.left) / rect.width) * 2 - 1;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (paused) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    controllerRef.current?.setPointer(event.pointerId, normalizePointer(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (paused || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    controllerRef.current?.setPointer(event.pointerId, normalizePointer(event.clientX));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    controllerRef.current?.releasePointer(event.pointerId);
  };

  const togglePause = async (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const next = await controllerRef.current?.togglePause();
    if (typeof next === 'boolean') setPaused(next);
  };

  return (
    <main
      ref={stageRef}
      className="screen game-screen"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <canvas ref={canvasRef} className="game-canvas" />
      <div className="game-vignette" />
      <header className="game-hud">
        <div className="score-block">
          <strong>{String(hud.score).padStart(6, '0')}</strong>
          <span>SCORE</span>
        </div>
        <button className="pause-button" type="button" aria-label={paused ? '继续游戏' : '暂停游戏'} onPointerDown={togglePause}>
          {paused ? <span className="resume-icon">▶</span> : <><i /><i /></>}
        </button>
      </header>

      <div className="star-progress" aria-hidden="true">
        <div className="star-line"><i style={{ width: `${hud.progress * 100}%` }} /></div>
        <div className="stars"><span>★</span><span>★</span><span>★</span><span>★</span><span>★</span></div>
      </div>

      <div className="progress-wrap">
        <div className="progress-labels"><span>RUN</span><b>{Math.floor(hud.progress * 100)}%</b></div>
        <div className="progress-track"><span style={{ width: `${hud.progress * 100}%` }} /></div>
      </div>

      {paused && (
        <div className="pause-overlay">
          <span>航行暂停</span>
          <strong>PAUSED</strong>
          <button type="button" onPointerDown={togglePause}>继续航行</button>
        </div>
      )}

    </main>
  );
}
