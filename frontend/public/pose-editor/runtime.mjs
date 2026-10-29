// 装配逻辑参考固定版本的 VNCCS PoseStudio；上游许可随资源缓存一同提供。
const MODEL_TIMEOUT_MS = 120000;

class MorphModels {
  constructor(url) {
    this.worker = new Worker(url, { type: "module" });
    this.seq = 0;
    this.pending = new Map();
    this.models = new Map();
    this.worker.onmessage = ({ data }) => {
      const task = this.pending.get(data.seq);
      if (!task) return;
      this.pending.delete(data.seq);
      clearTimeout(task.timer);
      if (data.type === "error")
        task.reject(new Error(`人体模型计算失败：${data.message}`));
      else task.resolve(data);
    };
    this.worker.onerror = (event) =>
      this.fail(new Error(`人体资源 Worker 加载失败：${event.message}`));
  }
  fail(error) {
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    this.pending.clear();
  }
  model(params) {
    const key = JSON.stringify(params);
    if (!this.models.has(key)) {
      const seq = ++this.seq;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(seq);
          reject(new Error("人体模型加载超时。"));
        }, MODEL_TIMEOUT_MS);
        this.pending.set(seq, { resolve, reject, timer });
        this.worker.postMessage({
          type: "solve",
          seq,
          clientId: 1,
          includeStatic: true,
          params,
        });
      });
      this.models.set(key, result);
    }
    return this.models.get(key);
  }
  dispose() {
    this.worker.terminate();
    this.fail(new Error("姿态编辑器已关闭。"));
    this.models.clear();
  }
}

function modelData(message) {
  const { staticData, bonePositions, vertices } = message;
  if (!staticData || !bonePositions || !vertices)
    throw new Error("人体 Worker 返回的模型数据不完整。");
  return {
    vertices,
    uvs: staticData.uvs,
    indices: staticData.indices,
    skinIndices: staticData.skinIndices,
    skinWeights: staticData.skinWeights,
    landmarks: message.landmarks,
    landmark_indices: message.landmarkIndices,
    bones: staticData.bones.map((bone, index) => {
      const start = index * 6;
      const headPos = Array.from(bonePositions.subarray(start, start + 3));
      const tailPos = Array.from(bonePositions.subarray(start + 3, start + 6));
      return {
        name: bone.name,
        parent: bone.parent || null,
        headPos,
        tailPos,
        length: Math.hypot(...tailPos.map((n, i) => n - headPos[i])),
      };
    }),
  };
}

function applyProportions(viewer, mesh) {
  for (const part of ["head", "arm", "hand", "foot"])
    viewer[`${part}Scale`] = mesh[`${part}_size`] ?? 1;
  const arm = mesh.arm_length ?? 0.5;
  const leg = mesh.leg_length ?? 0.5;
  viewer.boneLengthParams = {
    shoulder_l: mesh.shoulder_l_length ?? 0.5,
    shoulder_r: mesh.shoulder_r_length ?? 0.5,
    hip_l: mesh.hip_l_length ?? 0.5,
    hip_r: mesh.hip_r_length ?? 0.5,
    upper_arm_l: mesh.upper_arm_l_length ?? mesh.upper_arm_length ?? arm,
    upper_arm_r: mesh.upper_arm_r_length ?? mesh.upper_arm_length ?? arm,
    forearm_l: mesh.forearm_l_length ?? mesh.forearm_length ?? arm,
    forearm_r: mesh.forearm_r_length ?? mesh.forearm_length ?? arm,
    thigh_l: mesh.thigh_l_length ?? mesh.thigh_length ?? leg,
    thigh_r: mesh.thigh_r_length ?? mesh.thigh_length ?? leg,
    shin_l: mesh.shin_l_length ?? mesh.shin_length ?? leg,
    shin_r: mesh.shin_r_length ?? mesh.shin_length ?? leg,
    spine: mesh.spine_length ?? 0.5,
  };
}

export class PoseSceneRuntime {
  constructor(canvas, { assetBase, onPoseChange, onBoneSelection }) {
    this.canvas = canvas;
    this.assetBase = assetBase;
    this.onPoseChange = onPoseChange;
    this.onBoneSelection = onBoneSelection;
    this.disposed = false;
    this.loading = true;
    this.events = new AbortController();
    this.originalAddEventListener = canvas.addEventListener;
    // 上游核心在 canvas 上注册匿名事件；统一绑定生命周期，关闭时一并移除。
    const register = canvas.addEventListener.bind(canvas);
    canvas.addEventListener = (type, listener, options) => {
      const opts =
        typeof options === "boolean" ? { capture: options } : { ...options };
      opts.signal = opts.signal
        ? AbortSignal.any([opts.signal, this.events.signal])
        : this.events.signal;
      register(type, listener, opts);
    };
  }
  async initialize(scene, width, height) {
    const [core, characters, animation] = await Promise.all([
      import(`${this.assetBase}/pose_studio/core.js`),
      import(`${this.assetBase}/pose_studio/characters.mjs`),
      import(`${this.assetBase}/pose_studio/animation.mjs`),
    ]);
    if (this.disposed) throw new Error("姿态编辑器已关闭。");
    this.characters = characters;
    this.resolveCamera = animation.resolveCaptureCameraParams;
    this.models = new MorphModels(
      `${this.assetBase}/pose_studio/morph_worker.js`,
    );
    this.viewer = new core.PoseViewerCore(this.canvas, {
      skinMode: "naked",
      syncMode: "end",
      enableTextureSkinning: true,
      showSkeletonHelper: true,
      showCaptureFrame: false,
      showReferenceImage: false,
      onPoseChange: (pose) => {
        if (!this.loading) this.onPoseChange(pose);
      },
      onBoneSelectionChange: ({ boneName }) => this.onBoneSelection(boneName),
    });
    await this.viewer.init();
    if (this.viewer.initializationError)
      throw new Error(
        `三维视口初始化失败：${this.viewer.initializationError.message}`,
      );
    if (this.disposed) throw new Error("姿态编辑器已关闭。");
    // URL 已含固定提交，移除上游为开发刷新添加的时间戳以复用浏览器贴图缓存。
    this.viewer.THREE.DefaultLoadingManager.setURLModifier((url) =>
      url.startsWith(`${this.assetBase}/pose_studio/textures/`)
        ? url.split("?")[0]
        : url,
    );
    this.width = width;
    this.height = height;
    this.viewer.setSkinMode("naked");
    this.viewer.updateLights([
      { type: "ambient", color: "#ffffff", intensity: 1 },
    ]);
    this.viewer.setDirectionalSkydomeVisible(false);
    this.viewer.scene.background = new this.viewer.THREE.Color("#ffffff");
    await this.loadScene(scene, scene.active_character_id);
    this.snapToOutput();
  }
  camera(scene) {
    const pose = this.characters.extractActivePoseFromSceneAsset(scene);
    return this.resolveCamera(pose.cameraParams, {
      offset_x: 0,
      offset_y: 0,
      zoom: 1,
      yaw_deg: scene.camera?.yaw_deg ?? scene.export?.cam_yaw_deg ?? 0,
      pitch_deg: scene.camera?.pitch_deg ?? scene.export?.cam_pitch_deg ?? 0,
    });
  }
  async loadRig(character, pose) {
    const data = modelData(await this.models.model(character.mesh));
    if (this.disposed) throw new Error("姿态编辑器已关闭。");
    applyProportions(this.viewer, character.mesh);
    this.viewer.loadData(data, true);
    this.viewer.setPose(pose, true);
    this.viewer.setActiveCharacterAppearance({
      color: this.characters.normalizeCharacterColor(character.color),
      transform: character.transform,
    });
  }
  async loadScene(scene, editingId) {
    this.loading = true;
    try {
      this.scene = structuredClone(scene);
      this.editingId = editingId;
      const active = scene.characters.find(
        (character) => character.id === scene.active_character_id,
      );
      const editing = scene.characters.find(
        (character) => character.id === editingId,
      );
      this.viewer.clearPassiveCharacters();
      // 输出锚点始终来自原活动人物；切换编辑对象不能使相机中心跳动。
      this.viewer.resetSceneCameraTarget();
      await this.loadRig(active, active.poses[scene.activeTab]);
      for (const character of scene.characters) {
        if (character.id === editingId) continue;
        await this.loadRig(character, character.poses[scene.activeTab]);
        if (
          !this.viewer.upsertPassiveCharacterFromActive(character.id, {
            pose: character.poses[scene.activeTab],
            color: this.characters.normalizeCharacterColor(character.color),
            transform: character.transform,
          })
        )
          throw new Error(`无法装配场景人物：${character.id}`);
        // Three.js 的材质 clone 不复制着色回调，保留人偶边缘着色，避免切换编辑对象后外观改变。
        const material = this.viewer.passiveCharacters.get(character.id).mesh
          .material;
        material.onBeforeCompile =
          this.viewer.skinnedMesh.material.onBeforeCompile;
        material.needsUpdate = true;
      }
      await this.loadRig(editing, editing.poses[scene.activeTab]);
      this.viewer.deselectBone();
      await this.viewer.waitForCaptureReady();
      if (!this.viewer.cachedSkinTexture)
        throw new Error("人体材质贴图未成功加载。");
      this.viewer.setIKMode(true);
    } finally {
      this.loading = false;
    }
  }
  updateScene(scene) {
    this.scene = structuredClone(scene);
  }
  cameraParams() {
    return this.camera(this.scene);
  }
  currentPose() {
    return this.viewer.getPose();
  }
  resize(width, height) {
    this.viewer?.resize(width, height);
  }
  selectBone(name) {
    this.viewer.selectBoneByName(name);
  }
  boneNames() {
    return this.viewer.boneList.map((bone) => bone.name);
  }
  setIKMode(enabled) {
    this.viewer.setIKMode(enabled);
  }
  rotateBone(name, axis, degrees) {
    const pose = this.viewer.getPose();
    const rotation = pose.bones[name] ?? [0, 0, 0];
    rotation[axis] = degrees;
    pose.bones[name] = rotation;
    this.viewer.setPose(pose, true);
    this.viewer.updateIKEffectorPositions();
    this.onPoseChange(this.viewer.getPose());
  }
  transformCharacter(transform) {
    const character = this.scene.characters.find(
      (row) => row.id === this.editingId,
    );
    character.transform = { ...transform };
    this.viewer.setActiveCharacterAppearance({
      color: this.characters.normalizeCharacterColor(character.color),
      transform,
    });
  }
  snapToOutput() {
    const camera = this.cameraParams();
    this.viewer.snapToCaptureCamera(
      this.width,
      this.height,
      camera.zoom,
      camera.offset_x,
      camera.offset_y,
      camera.yaw_deg,
      camera.pitch_deg,
    );
    this.viewer.captureFrame.visible = false;
  }
  async capturePreview() {
    await this.viewer.waitForCaptureReady();
    const camera = this.cameraParams();
    const output = document.createElement("canvas");
    const captured = this.viewer.capture(
      this.width,
      this.height,
      camera.zoom,
      [255, 255, 255],
      camera.offset_x,
      camera.offset_y,
      camera.yaw_deg,
      camera.pitch_deg,
      { targetCanvas: output, hideReference: true },
    );
    if (!captured) throw new Error("人偶预览截图失败。");
    return new Promise((resolve, reject) =>
      output.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("人偶预览无法编码为 PNG。"));
      }, "image/png"),
    );
  }
  dispose() {
    this.disposed = true;
    this.events.abort();
    this.canvas.addEventListener = this.originalAddEventListener;
    this.models?.dispose();
    const renderer = this.viewer?.renderer;
    this.viewer?.dispose();
    renderer?.forceContextLoss();
  }
}
