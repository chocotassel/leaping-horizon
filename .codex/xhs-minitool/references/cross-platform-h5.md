# 跨端 H5 适配

> 小工具同一份 H5 同时跑在 PC 模拟器与真机 WebView。以下是保证两端一致体验的适配要点。

---

## 1. Android 8 WebView 兼容基线

- 所有页面最低适配 Android 8 WebView；不要仅以 PC 模拟器或新版浏览器的结果判断兼容性
- 禁止 CSS `inset: ...` 简写属性（这里指 `inset` 声明，不是 `safe-area-inset-*` 变量名），改用 `top` / `right` / `bottom` / `left`
- 使用较新的 CSS、JavaScript 语法或 Web API 前，确认 Android 8 WebView 可用；否则避免使用，或提供回退、polyfill / 编译降级

---

## 2. 触摸

```css
body { -webkit-touch-callout: none; }
.touchable:active { opacity: 0.7; }
html { touch-action: manipulation; }
```

交互优先用 Pointer Events（`pointerdown/move/up`）统一处理鼠标与触摸；纯触摸场景用 `touchstart/touchmove/touchend`。

---

## 3. 滚动

```css
.scroll-container {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}
```

纵向回弹由容器控制，HTML 无需额外配置。

---

## 4. 安全区

```css
.custom-nav { padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px)); }
.bottom-bar { padding-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)); }
```

需配合 `<meta name="viewport" ... viewport-fit=cover>`。PC 模拟器不产生真实 `env()`，而是注入 `--safe-area-inset-*` 变量模拟安全区；真机 `env()` 为真实值。用 `var(--safe-area-inset-*, env(...))` 组合，两端都生效。

---

## 5. 布局与媒体

- 页面级容器用 `%` / `flex` / `vw`，勿写死 `width: 375px`
- 图片 `max-width: 100%`
- 用系统字体栈，避免非必要 `.woff2`

---

## 6. PC 模拟器 vs 真机

| 特性 | PC 模拟器 | 真机 | 建议 |
| --- | --- | --- | --- |
| 触摸 | 鼠标 → touch 模拟 | 原生 touch | 用 pointer events 统一 |
| 安全区 | 注入 `--safe-area-inset-*` 变量模拟 | `env()` 真实值 | 用 `var(--safe-area-inset-*, env(safe-area-inset-*, 0px))` 组合 |
| 软键盘 | 无 | 遮挡输入框 | 监听 `visualViewport` 处理 |

---

## 7. 自检

- [ ] 已按 Android 8 WebView 检查 CSS / JavaScript / Web API，未使用 CSS `inset: ...` 简写；较新能力均有可用降级
- [ ] 交互用 pointer / touch events，未依赖鼠标 hover 才能触发的关键操作
- [ ] 布局自适应，无写死像素宽度
- [ ] 安全区用 `var(--safe-area-inset-*, env(safe-area-inset-*, 0px))` 组合，配合 `viewport-fit=cover`
- [ ] 图片自适应且体积受控
