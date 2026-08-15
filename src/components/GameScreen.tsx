import { useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../audio/AudioEngine';
import { GameController } from '../game/GameController';
import type { GameResult, Level } from '../types';

interface GameScreenProps {
  level: Level;
  onFinish: (result: GameResult) => void;
}

export function GameScreen({ level, onFinish }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const [hud, setHud] = useState({ score: 0, combo: 0, progress: 0 });
  const [paused, setPaused] = useState(false);
  const [dead, setDead] = useState(false);
  const [runId, setRunId] = useState(0);
  useEffect(() => {
    if (!canvasRef.current || !stageRef.current) return;
    const controller = new GameController(canvasRef.current, level, {
      onHud: (score, combo, progress) => setHud({ score, combo, progress }),
      onDeath: () => {
        setDead(true);
        setPaused(false);
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
  }, [level, onFinish, runId]);

  const normalizePointer = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return ((clientX - rect.left) / rect.width) * 2 - 1;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (paused || dead) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    controllerRef.current?.setPointer(event.pointerId, normalizePointer(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (paused || dead || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
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

  const restart = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setDead(false);
    setPaused(false);
    setHud({ score: 0, combo: 0, progress: 0 });
    void AudioEngine.unlock();
    setRunId((value) => value + 1);
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

      {dead && (
        <div className="death-overlay">
          <div className="death-icon">×</div>
          <span>撞上尖刺</span>
          <strong>RUN TERMINATED</strong>
          <p>红色尖刺无法击碎，左右滑动来躲开它。</p>
          <button type="button" onPointerDown={restart}>重新开始</button>
        </div>
      )}
    </main>
  );
}
