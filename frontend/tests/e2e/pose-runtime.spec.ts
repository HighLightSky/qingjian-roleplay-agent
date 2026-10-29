import { test, expect } from "@playwright/test";
import { poseScene } from "../pose-fixture";
import { POSE_RUNTIME_REVISION } from "../../lib/pose-editor/version";
import { writeFile } from "node:fs/promises";

for (const action of ["standing", "boxing", "sitting", "jumping"]) {
  test(`真实 WebGL 人偶渲染：${action}`, async ({ page }, info) => {
    test.setTimeout(120000);
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.route("**/pose-runtime-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body><canvas id="pose" width="512" height="512" style="width:512px;height:512px"></canvas></body></html>',
      }),
    );
    await page.goto("/pose-runtime-test");
    const result = await page.evaluate(
      async ({ sceneJSON, revision, action }) => {
        const scene = JSON.parse(sceneJSON);
        const modulePath = "/pose-editor/runtime.mjs";
        const { PoseSceneRuntime } = await import(
          /* webpackIgnore: true */ modulePath
        );
        const canvas = document.getElementById("pose") as HTMLCanvasElement;
        const runtime = new PoseSceneRuntime(canvas, {
          assetBase: `/vendor/vnccs/${revision}`,
          onPoseChange() {},
          onBoneSelection() {},
        });
        const width = action === "jumping" ? 512 : 256,
          height = action === "jumping" ? 256 : 512;
        try {
          await runtime.initialize(scene, width, height);
          const blob = await runtime.capturePreview();
          const bitmap = await createImageBitmap(blob);
          const output = document.createElement("canvas");
          output.width = bitmap.width;
          output.height = bitmap.height;
          const context = output.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          const pixels = context.getImageData(0, 0, width, height).data;
          let bodyPixels = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 230)
              bodyPixels++;
          const saved = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.readAsDataURL(blob);
          });
          return {
            width: output.width,
            height: output.height,
            bodyPixels,
            corner: Array.from(pixels.slice(0, 4)),
            saved,
          };
        } finally {
          runtime.dispose();
        }
      },
      {
        sceneJSON: JSON.stringify(poseScene(action)),
        revision: POSE_RUNTIME_REVISION,
        action,
      },
    );
    expect(failures).toEqual([]);
    expect(result.bodyPixels).toBeGreaterThan(500);
    expect(result.corner).toEqual([255, 255, 255, 255]);
    expect(result.width).toBe(action === "jumping" ? 512 : 256);
    expect(result.height).toBe(action === "jumping" ? 256 : 512);
    const path = info.outputPath(`${action}.png`);
    await writeFile(path, Buffer.from(result.saved, "base64"));
    await info.attach(action, { path, contentType: "image/png" });
  });
}

test("不同体型多角色切换编辑保持构图，原场景字段不被渲染改写", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.route("**/pose-runtime-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<canvas id="pose" width="640" height="512" style="width:640px;height:512px"></canvas>',
    }),
  );
  await page.goto("/pose-runtime-test");
  const source = poseScene();
  source.characters[0].transform.x = -4;
  source.characters[0].poses[0].cameraParams!.zoom = 0.65;
  const other = structuredClone(source.characters[0]);
  other.id = "other";
  other.mesh = { age: 45, gender: 1, height: 0.8, weight: 0.8 };
  other.transform.x = 4;
  source.characters.push(other);
  const result = await page.evaluate(
    async ({ sceneJSON, revision }) => {
      const path = "/pose-editor/runtime.mjs";
      const { PoseSceneRuntime } = await import(/* webpackIgnore: true */ path);
      const scene = JSON.parse(sceneJSON);
      const before = JSON.stringify(scene);
      const runtime = new PoseSceneRuntime(document.getElementById("pose"), {
        assetBase: `/vendor/vnccs/${revision}`,
        onPoseChange() {},
        onBoneSelection() {},
      });
      try {
        await runtime.initialize(scene, 512, 512);
        const first = await runtime.capturePreview();
        const anchor = runtime.viewer.sceneCameraTarget.toArray();
        const firstGeometry = Array.from(
          runtime.viewer.skinnedMesh.geometry.attributes.position.array,
        );
        const passiveGeometry = Array.from(
          runtime.viewer.passiveCharacters.get("other").mesh.geometry.attributes
            .position.array,
        );
        await runtime.loadScene(scene, "other");
        const second = await runtime.capturePreview();
        const bytes = async (blob: Blob) =>
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
            ),
          );
        const image = async (blob: Blob) => {
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          return {
            data: context.getImageData(0, 0, canvas.width, canvas.height).data,
            url: canvas.toDataURL().split(",")[1],
          };
        };
        const a = await image(first),
          b = await image(second);
        let different = 0,
          maximum = 0,
          total = 0;
        for (let i = 0; i < a.data.length; i++) {
          const delta = Math.abs(a.data[i] - b.data[i]);
          if (delta) different++;
          maximum = Math.max(maximum, delta);
          total += delta;
        }
        return {
          images: [a.url, b.url],
          different,
          maximum,
          total,
          equal:
            JSON.stringify(await bytes(first)) ===
            JSON.stringify(await bytes(second)),
          sameSource: before === JSON.stringify(scene),
          count: runtime.viewer.passiveCharacters.size + 1,
          differentBodies: firstGeometry.some(
            (n, index) => n !== passiveGeometry[index],
          ),
          anchor,
          nextAnchor: runtime.viewer.sceneCameraTarget.toArray(),
          active: runtime.scene.active_character_id,
        };
      } finally {
        runtime.dispose();
      }
    },
    { sceneJSON: JSON.stringify(source), revision: POSE_RUNTIME_REVISION },
  );
  for (const [index, encoded] of result.images.entries()) {
    const path = info.outputPath(`multi-${index}.png`);
    await writeFile(path, Buffer.from(encoded, "base64"));
    await info.attach(`multi-${index}`, { path, contentType: "image/png" });
  }
  console.log({
    different: result.different,
    maximum: result.maximum,
    total: result.total,
  });
  expect(result.sameSource).toBe(true);
  expect(result.count).toBe(2);
  expect(result.differentBodies).toBe(true);
  expect(result.anchor).toEqual(result.nextAnchor);
  expect(result.active).toBe("hero");
  expect(result.equal).toBe(true);
});

test("在真实画布拖动手部通过 IK 回调输出新姿势，观察视角不写入场景", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.route("**/pose-runtime-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<canvas id="pose" width="512" height="512" style="width:512px;height:512px;touch-action:none"></canvas>',
    }),
  );
  await page.goto("/pose-runtime-test");
  const hand = await page.evaluate(
    async ({ sceneJSON, revision }) => {
      const path = "/pose-editor/runtime.mjs";
      const { PoseSceneRuntime } = await import(/* webpackIgnore: true */ path);
      const scene = JSON.parse(sceneJSON);
      const runtime = new PoseSceneRuntime(document.getElementById("pose"), {
        assetBase: `/vendor/vnccs/${revision}`,
        onPoseChange(pose: unknown) {
          (window as any).lastPose = pose;
        },
        onBoneSelection() {},
      });
      (window as any).runtime = runtime;
      await runtime.initialize(scene, 512, 512);
      const position = runtime.viewer.bones.hand_l.getWorldPosition(
        new runtime.viewer.THREE.Vector3(),
      );
      position.project(runtime.viewer.camera);
      const rect = document.getElementById("pose")!.getBoundingClientRect();
      return {
        x: rect.left + ((position.x + 1) * rect.width) / 2,
        y: rect.top + ((1 - position.y) * rect.height) / 2,
      };
    },
    { sceneJSON: JSON.stringify(poseScene()), revision: POSE_RUNTIME_REVISION },
  );
  await page.mouse.move(hand.x, hand.y);
  await page.mouse.down();
  await page.mouse.move(hand.x - 30, hand.y + 45, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).lastPose))
    .toBe(true);
  const result = await page.evaluate(() => {
    const runtime = (window as any).runtime;
    const pose = (window as any).lastPose;
    const result = {
      bones: pose.bones,
      ik: pose.ikEffectorPositions,
      source: runtime.scene,
    };
    runtime.dispose();
    return JSON.stringify(result);
  });
  const edited = JSON.parse(result);
  expect(edited.bones).not.toEqual(poseScene().characters[0].poses[0].bones);
  expect(Object.keys(edited.ik).length).toBeGreaterThan(0);
  expect(edited.source).toEqual(poseScene());
});
