/**
 * 品牌标记（CutSpect / 镜谱）——内联 SVG，随构建打包，不依赖外部资源路径。
 *
 * 造型：圆角底板 + 四角取景框 + 分析曲线 + 三个关键节点。
 * 渐变/滤镜 id 统一加 `cs` 前缀，避免与页面内其他内联 SVG 的 id 冲突。
 */
export function BrandMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 1254 1254"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="csSurface" x1="202" y1="164" x2="1054" y2="1045" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#171A22" />
          <stop offset="0.52" stopColor="#10131A" />
          <stop offset="1" stopColor="#151820" />
        </linearGradient>
        <radialGradient
          id="csSurfaceGlow"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(630 525) rotate(90) scale(620 650)"
        >
          <stop stopColor="#202431" stopOpacity="0.42" />
          <stop offset="0.62" stopColor="#11141B" stopOpacity="0.08" />
          <stop offset="1" stopColor="#05060A" stopOpacity="0.3" />
        </radialGradient>
        <linearGradient id="csFrame" x1="260" y1="280" x2="1000" y2="926" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" />
          <stop offset="0.48" stopColor="#F3F4F7" />
          <stop offset="1" stopColor="#FFFFFF" />
        </linearGradient>
        <linearGradient id="csCurve" x1="120" y1="620" x2="1136" y2="530" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6B45F4" />
          <stop offset="0.28" stopColor="#815AFF" />
          <stop offset="0.58" stopColor="#7046F5" />
          <stop offset="0.82" stopColor="#835BFF" />
          <stop offset="1" stopColor="#6E46F7" />
        </linearGradient>
        <linearGradient id="csNode" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFBE32" />
          <stop offset="1" stopColor="#FF9E0D" />
        </linearGradient>
        <clipPath id="csIconClip">
          <rect x="118" y="138" width="1018" height="946" rx="160" />
        </clipPath>
        <filter id="csSurfaceShadow" x="78" y="98" width="1098" height="1026" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feDropShadow dx="0" dy="16" stdDeviation="24" floodColor="#000000" floodOpacity="0.32" />
        </filter>
        <filter id="csCurveGlow" x="80" y="360" width="1096" height="450" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="7" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="0 0 0 0 0.35  0 0 0 0 0.18  0 0 0 0 1  0 0 0 0.42 0"
          />
          <feBlend in="SourceGraphic" />
        </filter>
        <filter id="csNodeShadow" x="-40%" y="-40%" width="180%" height="180%" colorInterpolationFilters="sRGB">
          <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#000000" floodOpacity="0.34" />
        </filter>
      </defs>

      <g filter="url(#csSurfaceShadow)">
        <rect x="118" y="138" width="1018" height="946" rx="160" fill="url(#csSurface)" />
        <rect x="118" y="138" width="1018" height="946" rx="160" fill="url(#csSurfaceGlow)" />
        <rect
          x="119"
          y="139"
          width="1016"
          height="944"
          rx="159"
          stroke="#FFFFFF"
          strokeOpacity="0.025"
          strokeWidth="2"
        />
      </g>

      <g clipPath="url(#csIconClip)">
        <path
          d="M 104 629 C 238 629, 302 417, 458 417 C 619 417, 562 748, 773 748 C 930 748, 985 519, 1152 519"
          stroke="#4E2BCB"
          strokeOpacity="0.45"
          strokeWidth="42"
          strokeLinecap="round"
          filter="url(#csCurveGlow)"
        />
        <path
          d="M 104 629 C 238 629, 302 417, 458 417 C 619 417, 562 748, 773 748 C 930 748, 985 519, 1152 519"
          stroke="url(#csCurve)"
          strokeWidth="32"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <g filter="url(#csNodeShadow)">
          <rect x="432" y="391" width="52" height="52" rx="7" transform="rotate(45 458 417)" fill="url(#csNode)" />
          <rect x="747" y="722" width="52" height="52" rx="7" transform="rotate(45 773 748)" fill="url(#csNode)" />
          <rect x="953" y="587" width="52" height="52" rx="7" transform="rotate(45 979 613)" fill="url(#csNode)" />
        </g>
      </g>

      <g stroke="url(#csFrame)" strokeWidth="28" strokeLinecap="round" strokeLinejoin="round">
        <path d="M 540 290 H 335 C 293 290 260 323 260 365 V 492" />
        <path d="M 714 290 H 919 C 961 290 994 323 994 365 V 492" />
        <path d="M 260 701 V 850 C 260 892 293 918 335 918 H 540" />
        <path d="M 714 918 H 919 C 961 918 994 885 994 843 V 701" />
      </g>
    </svg>
  );
}