// @refresh reset
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./App.css";

import { Notifications } from "@mantine/notifications";

import {
  AdaptiveDpr,
  AdaptiveEvents,
  CameraControls,
  Environment,
} from "@react-three/drei";
import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";

import { SynchronizedCameraControls } from "./CameraControls";
import {
  Anchor,
  Box,
  ColorSchemeScript,
  Image,
  MantineProvider,
  Modal,
  Tooltip,
  createTheme,
  useMantineTheme,
} from "@mantine/core";
import React, { useEffect } from "react";
import { SceneNodeThreeObject, UseSceneTree } from "./SceneTree";

import "./index.css";

import ControlPanel from "./ControlPanel/ControlPanel";
import { UseGui, useGuiState } from "./ControlPanel/GuiState";
import { searchParamKey } from "./SearchParamsUtils";
import { WebsocketMessageProducer } from "./WebsocketInterface";

import { Titlebar } from "./Titlebar";
import { ViserModal } from "./Modal";
import { useSceneTreeState } from "./SceneTreeState";
import { GetRenderRequestMessage, Message } from "./WebsocketMessages";
import { makeThrottledMessageSender } from "./WebsocketFunctions";
import { useDisclosure } from "@mantine/hooks";
import { rayToViserCoords } from "./WorldTransformUtils";
import { ndcFromPointerXy, opencvXyFromPointerXy } from "./ClickUtils";
import { theme } from "./AppTheme";
import { GaussianSplatsContext } from "./Splatting/GaussianSplats";
import { FrameSynchronizedMessageHandler } from "./MessageHandler";
import { PlaybackFromFile } from "./FilePlayback";

export type ViewerContextContents = {
  messageSource: "websocket" | "file_playback";
  // Zustand hooks.
  useSceneTree: UseSceneTree;
  useGui: UseGui;
  // Useful references.
  // TODO: there's really no reason these all need to be their own ref objects.
  // We could have just one ref to a global mutable struct.
  websocketRef: React.MutableRefObject<WebSocket | null>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  sceneRef: React.MutableRefObject<THREE.Scene | null>;
  cameraRef: React.MutableRefObject<THREE.PerspectiveCamera | null>;
  backgroundMaterialRef: React.MutableRefObject<THREE.ShaderMaterial | null>;
  cameraControlRef: React.MutableRefObject<CameraControls | null>;
  sendCameraRef: React.MutableRefObject<(() => void) | null>;
  resetCameraViewRef: React.MutableRefObject<(() => void) | null>;
  // Scene node attributes.
  // This is intentionally placed outside of the Zustand state to reduce overhead.
  nodeAttributesFromName: React.MutableRefObject<{
    [name: string]:
      | undefined
      | {
          poseUpdateState?: "updated" | "needsUpdate" | "waitForMakeObject";
          wxyz?: [number, number, number, number];
          position?: [number, number, number];
          visibility?: boolean; // Visibility state from the server.
          overrideVisibility?: boolean; // Override from the GUI.
        };
  }>;
  nodeRefFromName: React.MutableRefObject<{
    [name: string]: undefined | THREE.Object3D;
  }>;
  messageQueueRef: React.MutableRefObject<Message[]>;
  // Requested a render.
  getRenderRequestState: React.MutableRefObject<
    "ready" | "triggered" | "pause" | "in_progress"
  >;
  getRenderRequest: React.MutableRefObject<null | GetRenderRequestMessage>;
  // Track click drag events.
  scenePointerInfo: React.MutableRefObject<{
    enabled: false | "click" | "rect-select"; // Enable box events.
    dragStart: [number, number]; // First mouse position.
    dragEnd: [number, number]; // Final mouse position.
    isDragging: boolean;
  }>;
  // 2D canvas for drawing -- can be used to give feedback on cursor movement, or more.
  canvas2dRef: React.MutableRefObject<HTMLCanvasElement | null>;
  // Poses for bones in skinned meshes.
  skinnedMeshState: React.MutableRefObject<{
    [name: string]: {
      initialized: boolean;
      poses: {
        wxyz: [number, number, number, number];
        position: [number, number, number];
      }[];
    };
  }>;
};
export const ViewerContext = React.createContext<null | ViewerContextContents>(
  null,
);

THREE.ColorManagement.enabled = true;

function ViewerRoot() {
  // What websocket server should we connect to?
  function getDefaultServerFromUrl() {
    // https://localhost:8080/ => ws://localhost:8080
    // https://localhost:8080/?server=some_url => ws://localhost:8080
    let server = window.location.href;
    server = server.replace("http://", "ws://");
    server = server.replace("https://", "wss://");
    server = server.split("?")[0];
    if (server.endsWith("/")) server = server.slice(0, -1);
    return server;
  }
  const servers = new URLSearchParams(window.location.search).getAll(
    searchParamKey,
  );
  const initialServer =
    servers.length >= 1 ? servers[0] : getDefaultServerFromUrl();

  // Playback mode for embedding viser.
  const playbackPath = new URLSearchParams(window.location.search).get(
    "playbackPath",
  );
  console.log(playbackPath);

  // Values that can be globally accessed by components in a viewer.
  const viewer: ViewerContextContents = {
    messageSource: playbackPath === null ? "websocket" : "file_playback",
    useSceneTree: useSceneTreeState(),
    useGui: useGuiState(initialServer),
    websocketRef: React.useRef(null),
    canvasRef: React.useRef(null),
    sceneRef: React.useRef(null),
    cameraRef: React.useRef(null),
    backgroundMaterialRef: React.useRef(null),
    cameraControlRef: React.useRef(null),
    sendCameraRef: React.useRef(null),
    resetCameraViewRef: React.useRef(null),
    // Scene node attributes that aren't placed in the zustand state for performance reasons.
    nodeAttributesFromName: React.useRef({
      "": {
        wxyz: (() => {
          const quat = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(Math.PI / 2, Math.PI, -Math.PI / 2),
          );
          return [quat.w, quat.x, quat.y, quat.z];
        })(),
      },
    }),
    nodeRefFromName: React.useRef({}),
    messageQueueRef: React.useRef([]),
    getRenderRequestState: React.useRef("ready"),
    getRenderRequest: React.useRef(null),
    scenePointerInfo: React.useRef({
      enabled: false,
      dragStart: [0, 0],
      dragEnd: [0, 0],
      isDragging: false,
    }),
    canvas2dRef: React.useRef(null),
    skinnedMeshState: React.useRef({}),
  };

  return (
    <ViewerContext.Provider value={viewer}>
      {viewer.messageSource === "websocket" ? (
        <WebsocketMessageProducer />
      ) : null}
      {viewer.messageSource === "file_playback" ? (
        <PlaybackFromFile fileUrl={playbackPath!} />
      ) : null}
      <ViewerContents />
    </ViewerContext.Provider>
  );
}

function ViewerContents() {
  const viewer = React.useContext(ViewerContext)!;
  const dark_mode = viewer.useGui((state) => state.theme.dark_mode);
  const colors = viewer.useGui((state) => state.theme.colors);
  const control_layout = viewer.useGui((state) => state.theme.control_layout);
  return (
    <>
      <ColorSchemeScript forceColorScheme={dark_mode ? "dark" : "light"} />
      <MantineProvider
        theme={createTheme({
          ...theme,
          ...(colors === null
            ? {}
            : { colors: { custom: colors }, primaryColor: "custom" }),
        })}
        forceColorScheme={dark_mode ? "dark" : "light"}
      >
        <Notifications
          position="top-left"
          containerWidth="20em"
          styles={{
            root: {
              boxShadow: "0.1em 0 1em 0 rgba(0,0,0,0.1) !important",
            },
          }}
        />
        <ViserModal />
        <Box
          style={{
            width: "100%",
            height: "100%",
            // We use flex display for the titlebar layout.
            display: "flex",
            position: "relative",
            flexDirection: "column",
          }}
        >
          <Titlebar />
          <Box
            style={{
              // Put the canvas and control panel side-by-side.
              width: "100%",
              position: "relative",
              flexGrow: 1,
              overflow: "hidden",
              display: "flex",
            }}
          >
            <Box
              style={(theme) => ({
                backgroundColor: dark_mode ? theme.colors.dark[9] : "#fff",
                flexGrow: 1,
                overflow: "hidden",
                height: "100%",
              })}
            >
              <Viewer2DCanvas />
              <GaussianSplatsContext.Provider
                value={React.useRef({ numSorting: 0, sortUpdateCallbacks: [] })}
              >
                <ViewerCanvas>
                  <FrameSynchronizedMessageHandler />
                </ViewerCanvas>
              </GaussianSplatsContext.Provider>
              {viewer.useGui((state) => state.theme.show_logo) &&
              viewer.messageSource == "websocket" ? (
                <ViserLogo />
              ) : null}
            </Box>
            {viewer.messageSource == "websocket" ? (
              <ControlPanel control_layout={control_layout} />
            ) : null}
          </Box>
        </Box>
      </MantineProvider>
    </>
  );
}

function ViewerCanvas({ children }: { children: React.ReactNode }) {
  const viewer = React.useContext(ViewerContext)!;
  const sendClickThrottled = makeThrottledMessageSender(
    viewer.websocketRef,
    20,
  );
  const theme = useMantineTheme();

  return (
    <Canvas
      camera={{ position: [-3.0, 3.0, -3.0], near: 0.05 }}
      gl={{ preserveDrawingBuffer: true }}
      style={{
        position: "relative",
        zIndex: 0,
        width: "100%",
        height: "100%",
      }}
      performance={{ min: 0.95 }}
      ref={viewer.canvasRef}
      // Handle scene click events (onPointerDown, onPointerMove, onPointerUp)
      onPointerDown={(e) => {
        const pointerInfo = viewer.scenePointerInfo.current!;

        // Only handle pointer events if enabled.
        if (pointerInfo.enabled === false) return;

        // Keep track of the first click position.
        const canvasBbox = viewer.canvasRef.current!.getBoundingClientRect();
        pointerInfo.dragStart = [
          e.clientX - canvasBbox.left,
          e.clientY - canvasBbox.top,
        ];
        pointerInfo.dragEnd = pointerInfo.dragStart;

        // Check if pointer position is in bounds.
        if (ndcFromPointerXy(viewer, pointerInfo.dragEnd) === null) return;

        // Only allow one drag event at a time.
        if (pointerInfo.isDragging) return;
        pointerInfo.isDragging = true;

        // Disable camera controls -- we don't want the camera to move while we're dragging.
        viewer.cameraControlRef.current!.enabled = false;

        const ctx = viewer.canvas2dRef.current!.getContext("2d")!;
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      }}
      onPointerMove={(e) => {
        const pointerInfo = viewer.scenePointerInfo.current!;

        // Only handle if click events are enabled, and if pointer is down (i.e., dragging).
        if (pointerInfo.enabled === false || !pointerInfo.isDragging) return;

        // Check if pointer position is in boudns.
        const canvasBbox = viewer.canvasRef.current!.getBoundingClientRect();
        const pointerXy: [number, number] = [
          e.clientX - canvasBbox.left,
          e.clientY - canvasBbox.top,
        ];
        if (ndcFromPointerXy(viewer, pointerXy) === null) return;

        // Check if mouse position has changed sufficiently from last position.
        // Uses 3px as a threshood, similar to drag detection in
        // `SceneNodeClickMessage` from `SceneTree.tsx`.
        pointerInfo.dragEnd = pointerXy;
        if (
          Math.abs(pointerInfo.dragEnd[0] - pointerInfo.dragStart[0]) <= 3 &&
          Math.abs(pointerInfo.dragEnd[1] - pointerInfo.dragStart[1]) <= 3
        )
          return;

        // If we're listening for scene box events, draw the box on the 2D canvas for user feedback.
        if (pointerInfo.enabled === "rect-select") {
          const ctx = viewer.canvas2dRef.current!.getContext("2d")!;
          ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
          ctx.beginPath();
          ctx.fillStyle = theme.primaryColor;
          ctx.strokeStyle = "blue";
          ctx.globalAlpha = 0.2;
          ctx.fillRect(
            pointerInfo.dragStart[0],
            pointerInfo.dragStart[1],
            pointerInfo.dragEnd[0] - pointerInfo.dragStart[0],
            pointerInfo.dragEnd[1] - pointerInfo.dragStart[1],
          );
          ctx.globalAlpha = 1.0;
          ctx.stroke();
        }
      }}
      onPointerUp={() => {
        const pointerInfo = viewer.scenePointerInfo.current!;

        // Re-enable camera controls! Was disabled in `onPointerDown`, to allow
        // for mouse drag w/o camera movement.
        viewer.cameraControlRef.current!.enabled = true;

        // Only handle if click events are enabled, and if pointer was down (i.e., dragging).
        if (pointerInfo.enabled === false || !pointerInfo.isDragging) return;

        const ctx = viewer.canvas2dRef.current!.getContext("2d")!;
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        // If there's only one pointer, send a click message.
        // The message will return origin/direction lists of length 1.
        if (pointerInfo.enabled === "click") {
          const raycaster = new THREE.Raycaster();

          // Raycaster expects NDC coordinates, so we convert the click event to NDC.
          const mouseVector = ndcFromPointerXy(viewer, pointerInfo.dragEnd);
          if (mouseVector === null) return;
          raycaster.setFromCamera(mouseVector, viewer.cameraRef.current!);
          const ray = rayToViserCoords(viewer, raycaster.ray);

          // Send OpenCV image coordinates to the server (normalized).
          const mouseVectorOpenCV = opencvXyFromPointerXy(
            viewer,
            pointerInfo.dragEnd,
          );

          sendClickThrottled({
            type: "ScenePointerMessage",
            event_type: "click",
            ray_origin: [ray.origin.x, ray.origin.y, ray.origin.z],
            ray_direction: [ray.direction.x, ray.direction.y, ray.direction.z],
            screen_pos: [[mouseVectorOpenCV.x, mouseVectorOpenCV.y]],
          });
        } else if (pointerInfo.enabled === "rect-select") {
          // If the ScenePointerEvent had mouse drag movement, we will send a "box" message:
          // Use the first and last mouse positions to create a box.
          // Again, click should be in openCV image coordinates (normalized).
          const firstMouseVector = opencvXyFromPointerXy(
            viewer,
            pointerInfo.dragStart,
          );
          const lastMouseVector = opencvXyFromPointerXy(
            viewer,
            pointerInfo.dragEnd,
          );

          const x_min = Math.min(firstMouseVector.x, lastMouseVector.x);
          const x_max = Math.max(firstMouseVector.x, lastMouseVector.x);
          const y_min = Math.min(firstMouseVector.y, lastMouseVector.y);
          const y_max = Math.max(firstMouseVector.y, lastMouseVector.y);

          // Send the upper-left and lower-right corners of the box.
          const screenBoxList: [number, number][] = [
            [x_min, y_min],
            [x_max, y_max],
          ];

          sendClickThrottled({
            type: "ScenePointerMessage",
            event_type: "rect-select",
            ray_origin: null,
            ray_direction: null,
            screen_pos: screenBoxList,
          });
        }

        // Release drag lock.
        pointerInfo.isDragging = false;
      }}
    >
      {children}
      <BackgroundImage />
      <AdaptiveDpr pixelated />
      <AdaptiveEvents />
      <SceneContextSetter />
      <SynchronizedCameraControls />
      <SceneNodeThreeObject name="" parent={null} />
      <Environment path="/hdri/" files="potsdamer_platz_1k.hdr" />
      <directionalLight color={0xffffff} intensity={1.0} position={[0, 1, 0]} />
      <directionalLight
        color={0xffffff}
        intensity={0.2}
        position={[0, -1, 0]}
      />
    </Canvas>
  );
}

/* HTML Canvas, for drawing 2D. */
function Viewer2DCanvas() {
  const viewer = React.useContext(ViewerContext)!;
  useEffect(() => {
    // Create a resize observer to resize the CSS canvas when the window is resized.
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      canvas.width = width;
      canvas.height = height;
    });

    // Observe the canvas.
    const canvas = viewer.canvas2dRef.current!;
    resizeObserver.observe(canvas);

    // Cleanup
    return () => resizeObserver.disconnect();
  });
  return (
    <canvas
      ref={viewer.canvas2dRef}
      style={{
        position: "absolute",
        zIndex: 1,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

/* Background image with support for depth compositing. */
function BackgroundImage() {
  // Create a fragment shader that composites depth using depth and rgb
  const vertShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
  `.trim();
  const fragShader = `
  #include <packing>
  precision highp float;
  precision highp int;

  varying vec2 vUv;
  uniform sampler2D colorMap;
  uniform sampler2D depthMap;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform bool enabled;
  uniform bool hasDepth;

  float readDepth(sampler2D depthMap, vec2 coord) {
    vec4 rgbPacked = texture(depthMap, coord);

    // For the k-th channel, coefficients are calculated as: 255 * 1e-5 * 2^(8 * k).
    // Note that: [0, 255] channels are scaled to [0, 1], and we multiply by 1e5 on the server side.
    float depth = rgbPacked.r * 0.00255 + rgbPacked.g * 0.6528 + rgbPacked.b * 167.1168;
    return depth;
  }

  void main() {
    if (!enabled) {
      // discard the pixel if we're not enabled
      discard;
    }
    vec4 color = texture(colorMap, vUv);
    gl_FragColor = vec4(color.rgb, 1.0);

    float bufDepth;
    if(hasDepth){
      float depth = readDepth(depthMap, vUv);
      bufDepth = viewZToPerspectiveDepth(-depth, cameraNear, cameraFar);
    } else {
      // If no depth enabled, set depth to 1.0 (infinity) to treat it like a background image.
      bufDepth = 1.0;
    }
    gl_FragDepth = bufDepth;
  }`.trim();
  // initialize the rgb texture with all white and depth at infinity
  const backgroundMaterial = new THREE.ShaderMaterial({
    fragmentShader: fragShader,
    vertexShader: vertShader,
    uniforms: {
      enabled: { value: false },
      depthMap: { value: null },
      colorMap: { value: null },
      cameraNear: { value: null },
      cameraFar: { value: null },
      hasDepth: { value: false },
    },
  });
  const { backgroundMaterialRef } = React.useContext(ViewerContext)!;
  backgroundMaterialRef.current = backgroundMaterial;
  const backgroundMesh = React.useRef<THREE.Mesh>(null);
  useFrame(({ camera }) => {
    // Logic ahead relies on perspective camera assumption.
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      console.error(
        "Camera is not a perspective camera, cannot render background image",
      );
      return;
    }

    // Update the position of the mesh based on the camera position.
    const lookdir = camera.getWorldDirection(new THREE.Vector3());
    backgroundMesh.current!.position.set(
      camera.position.x,
      camera.position.y,
      camera.position.z,
    );
    backgroundMesh.current!.position.addScaledVector(lookdir, 1.0);
    backgroundMesh.current!.quaternion.copy(camera.quaternion);

    // Resize the mesh based on focal length.
    const f = camera.getFocalLength();
    backgroundMesh.current!.scale.set(
      camera.getFilmWidth() / f,
      camera.getFilmHeight() / f,
      1.0,
    );

    // Set near/far uniforms.
    backgroundMaterial.uniforms.cameraNear.value = camera.near;
    backgroundMaterial.uniforms.cameraFar.value = camera.far;
  });

  return (
    <mesh
      ref={backgroundMesh}
      material={backgroundMaterial}
      matrixWorldAutoUpdate={false}
    >
      <planeGeometry attach="geometry" args={[1, 1]} />
    </mesh>
  );
}

/** Component for helping us set the scene reference. */
function SceneContextSetter() {
  const { sceneRef, cameraRef } = React.useContext(ViewerContext)!;
  sceneRef.current = useThree((state) => state.scene);
  cameraRef.current = useThree(
    (state) => state.camera as THREE.PerspectiveCamera,
  );
  return <></>;
}

export function Root() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ViewerRoot />
    </div>
  );
}

/** Logo. When clicked, opens an info modal. */
function ViserLogo() {
  const [aboutModalOpened, { open: openAbout, close: closeAbout }] =
    useDisclosure(false);
  return (
    <>
      <Tooltip label="About Viser">
        <Box
          style={{
            position: "absolute",
            bottom: "1em",
            left: "1em",
            cursor: "pointer",
          }}
          component="a"
          onClick={openAbout}
          title="About Viser"
        >
          <Image src="/logo.svg" style={{ width: "2.5em", height: "auto" }} />
        </Box>
      </Tooltip>
      <Modal
        opened={aboutModalOpened}
        onClose={closeAbout}
        withCloseButton={false}
        size="xl"
        ta="center"
      >
        <Box>
          <p>Viser is a 3D visualization toolkit developed at UC Berkeley.</p>
          <p>
            <Anchor
              href="https://github.com/nerfstudio-project/"
              target="_blank"
              fw="600"
              style={{ "&:focus": { outline: "none" } }}
            >
              Nerfstudio
            </Anchor>
            &nbsp;&nbsp;&bull;&nbsp;&nbsp;
            <Anchor
              href="https://github.com/nerfstudio-project/viser"
              target="_blank"
              fw="600"
              style={{ "&:focus": { outline: "none" } }}
            >
              GitHub
            </Anchor>
            &nbsp;&nbsp;&bull;&nbsp;&nbsp;
            <Anchor
              href="https://viser.studio/latest"
              target="_blank"
              fw="600"
              style={{ "&:focus": { outline: "none" } }}
            >
              Documentation
            </Anchor>
          </p>
        </Box>
      </Modal>
    </>
  );
}
