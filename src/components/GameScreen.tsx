import { useEffect, useRef, useState } from 'react';
import { GameController } from '../game/GameController';
import { type GameResult, type Level } from '../types';

interface GameScreenProps {
  level: Level;
  musicEnabled: boolean;
  onDeath: (result: GameResult) => void;
  onExit: () => void;
  onFinish: (result: GameResult) => void;
  onToggleMusic: () => void;
}

export function GameScreen({
  level,
  musicEnabled,
  onDeath,
  onExit,
  onFinish,
  onToggleMusic,
}: GameScreenProps) {
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

  const stopGamePointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const togglePause = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const next = await controllerRef.current?.togglePause();
    if (typeof next === 'boolean') setPaused(next);
  };

  const togglePauseMusic = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggleMusic();
  };

  const exitGame = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onExit();
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
          <span>本次得分</span>
        </div>
        <div className={`combo-block ${hud.combo > 0 ? 'is-active' : ''}`}>
          <span>COMBO</span>
          <strong>{hud.combo}</strong>
        </div>
        <button
          className="pause-button"
          type="button"
          aria-label={paused ? '继续游戏' : '暂停游戏'}
          onPointerDown={stopGamePointer}
          onClick={togglePause}
        >
          {paused ? <span className="resume-icon">▶</span> : <><i /><i /></>}
        </button>
      </header>

      <div className="game-beat-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>

      <div
        className="route-progress"
        role="progressbar"
        aria-label="航行进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(hud.progress * 100)}
      >
        <div className="route-progress-copy">
          <span>航行进度</span>
          <strong>{Math.floor(hud.progress * 100)}%</strong>
        </div>
        <div className="route-progress-track">
          <span style={{ width: `${hud.progress * 100}%` }} />
          <i style={{ left: `${hud.progress * 100}%` }} />
        </div>
      </div>

      {paused && (
        <div className="pause-overlay">
          <div className="pause-orbit" aria-hidden="true"><i /><span>Ⅱ</span></div>
          <span>航行暂停</span>
          <strong>PAUSED</strong>
          <button
            className={`pause-music-toggle ${musicEnabled ? 'is-enabled' : ''}`}
            type="button"
            aria-pressed={musicEnabled}
            onPointerDown={stopGamePointer}
            onClick={togglePauseMusic}
          >
            <span aria-hidden="true">♪</span>
            <strong>游戏音乐</strong>
            <small>{musicEnabled ? '已开启' : '已关闭'}</small>
            <i aria-hidden="true" />
          </button>
          <div className="pause-actions">
            <button className="pause-primary-button" type="button" onPointerDown={stopGamePointer} onClick={togglePause}>
              继续航行
            </button>
            <button className="pause-exit-button" type="button" onPointerDown={stopGamePointer} onClick={exitGame}>
              结束并返回选歌
            </button>
          </div>
        </div>
      )}

    </main>
  );
}
