"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, ToneMapping, Vignette } from "@react-three/postprocessing";
import { BlendFunction, ToneMappingMode, type BloomEffect } from "postprocessing";
import { useCore } from "./context";

/**
 * Medium+ only. Bloom thresholds high so only genuinely emissive (HDR > 1)
 * parts glow; tone mapping, then a subtle vignette and film grain.
 */
export function PostFX() {
  const { preset, drive } = useCore();
  const bloom = useRef<BloomEffect>(null);

  useFrame(() => {
    if (bloom.current) bloom.current.intensity = 0.85 * drive.bloom;
  });

  return (
    <EffectComposer multisampling={preset.multisampling} enableNormalPass={false} stencilBuffer={false}>
      <Bloom
        ref={bloom}
        mipmapBlur
        luminanceThreshold={0.72}
        luminanceSmoothing={0.22}
        intensity={0.85}
        radius={0.7}
        levels={preset.bloomLevels}
      />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <Vignette offset={0.3} darkness={0.62} />
      <Noise premultiply blendFunction={BlendFunction.ADD} opacity={0.32} />
    </EffectComposer>
  );
}
