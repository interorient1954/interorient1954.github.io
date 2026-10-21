/*
 * Interorient Navigation: office globe, adapted from the Interorient Shipping Fund site.
 *
 * ES module, imported on demand by index.html when the offices section approaches the viewport.
 * Draws a dotted-land globe with Three.js, marks each office and links the first office (head
 * office) to the others. Drag to turn it; selecting an office in the list turns it to face you.
 * Only the selected office is labelled, so the close-together European offices stay legible.
 * Rendering pauses whenever the globe is off screen or the tab is hidden.
 */
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js';
const TOPOJSON_URL = 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm';
const LAND_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json';

const DEG = Math.PI / 180;
const GOLD = 0xe8a438;
const FOAM = 0xf2f5f8;

function landMask(topojson, land) {
    const width = 1024;
    const height = 512;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const geo = topojson.feature(land, land.objects.land);
    const features = geo.type === 'FeatureCollection' ? geo.features : [geo];
    const project = ([lng, lat]) => [((lng + 180) / 360) * width, ((90 - lat) / 180) * height];
    // Shapes that cross the 180 degree meridian (Chukotka, Fiji) would otherwise be drawn the long
    // way round as thin bands across the whole map. Their longitudes are unwrapped into a
    // continuous run and the shape is drawn shifted by -360, 0 and +360 so each part lands on the
    // right edge. Rings around the south pole already span the full width and are drawn as given.
    const unwrap = (ring) => {
        let previous = null;
        return ring.map(([lng, lat]) => {
            let value = lng;
            if (previous !== null) {
                while (value - previous > 180) {
                    value -= 360;
                }
                while (value - previous < -180) {
                    value += 360;
                }
            }
            previous = value;
            return [value, lat];
        });
    };
    const drawPolygon = (polygon) => {
        const polar = polygon.some((ring) => ring.some(([, lat]) => lat < -85));
        const rings = polar ? polygon : polygon.map(unwrap);
        (polar ? [0] : [-360, 0, 360]).forEach((offset) => {
            context.beginPath();
            rings.forEach((ring) => {
                ring.forEach(([lng, lat], index) => {
                    const [x, y] = project([lng + offset, lat]);
                    if (index === 0) {
                        context.moveTo(x, y);
                    } else {
                        context.lineTo(x, y);
                    }
                });
            });
            context.fill('evenodd');
        });
    };
    context.fillStyle = '#fff';
    features.forEach((feature) => {
        const geometry = feature.geometry;
        if (!geometry) {
            return;
        }
        if (geometry.type === 'Polygon') {
            drawPolygon(geometry.coordinates);
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(drawPolygon);
        }
    });
    const pixels = context.getImageData(0, 0, width, height).data;
    return (lat, lng) => {
        const x = Math.min(width - 1, Math.max(0, Math.floor(((lng + 180) / 360) * width)));
        const y = Math.min(height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * height)));
        return pixels[(y * width + x) * 4] > 127;
    };
}

function dotTexture(THREE) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.beginPath();
    context.arc(32, 32, 26, 0, Math.PI * 2);
    context.fill();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export async function mountGlobe(container, offices, options = {}) {
    const [THREE, topojson, land] = await Promise.all([
        import(THREE_URL),
        import(TOPOJSON_URL),
        fetch(LAND_URL).then((response) => response.json())
    ]);

    const reducedMotion = !!options.reducedMotion;
    const toVector = (lat, lng, radius = 1) => {
        const phi = (90 - lat) * DEG;
        const theta = (lng + 180) * DEG;
        return new THREE.Vector3(
            -Math.sin(phi) * Math.cos(theta) * radius,
            Math.cos(phi) * radius,
            Math.sin(phi) * Math.sin(theta) * radius
        );
    };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0, 4.25);

    const globe = new THREE.Group();
    scene.add(globe);

    // Ocean body
    globe.add(new THREE.Mesh(
        new THREE.SphereGeometry(0.994, 64, 64),
        new THREE.MeshBasicMaterial({ color: 0x163b60 })
    ));

    // Soft rim light so the sphere separates from the navy page
    const rim = new THREE.Mesh(
        new THREE.SphereGeometry(1.12, 64, 64),
        new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            uniforms: { uColor: { value: new THREE.Color(0x3f6f9f) } },
            vertexShader: 'varying vec3 vNormal; void main() { vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: 'uniform vec3 uColor; varying vec3 vNormal; void main() { float rim = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 4.0); gl_FragColor = vec4(uColor, clamp(rim, 0.0, 1.0) * 0.32); }'
        })
    );
    scene.add(rim);

    // Land as an even field of dots (Fibonacci sphere sampled against a land mask)
    const isLand = landMask(topojson, land);
    const total = options.compact ? 16000 : 26000;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const positions = [];
    for (let i = 0; i < total; i += 1) {
        const y = 1 - (i / (total - 1)) * 2;
        const radius = Math.sqrt(1 - y * y);
        const angle = golden * i;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const lat = Math.asin(y) / DEG;
        const theta = ((Math.atan2(z, -x) / DEG) + 360) % 360;
        const lng = theta - 180;
        if (isLand(lat, lng)) {
            positions.push(x * 1.002, y * 1.002, z * 1.002);
        }
    }
    const dotGeometry = new THREE.BufferGeometry();
    dotGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    globe.add(new THREE.Points(dotGeometry, new THREE.PointsMaterial({
        size: options.compact ? 0.026 : 0.021,
        sizeAttenuation: true,
        map: dotTexture(THREE),
        transparent: true,
        alphaTest: 0.35,
        depthWrite: false,
        color: 0xe4ecf4,
        opacity: 0.95
    })));

    // Office markers
    const markers = offices.map((office) => {
        const group = new THREE.Group();
        const position = toVector(office.lat, office.lng, 1.004);
        group.position.copy(position);
        group.lookAt(position.clone().multiplyScalar(2));
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.022, 32), new THREE.MeshBasicMaterial({ color: FOAM }));
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.034, 0.042, 48), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0, side: THREE.DoubleSide }));
        group.add(dot);
        group.add(ring);
        globe.add(group);
        const label = document.createElement('span');
        label.className = 'globe-label';
        label.textContent = office.name;
        container.appendChild(label);
        return { office, group, dot, ring, label, anchor: toVector(office.lat, office.lng, 1.03) };
    });

    // Arcs from the head office (first in the list) to the other offices
    const arcMaterials = [];
    if (markers.length > 1) {
        const origin = toVector(offices[0].lat, offices[0].lng);
        offices.slice(1).forEach((office) => {
            const target = toVector(office.lat, office.lng);
            const span = origin.angleTo(target);
            const points = [];
            for (let i = 0; i <= 96; i += 1) {
                const t = i / 96;
                const point = origin.clone().lerp(target, t).normalize();
                // Capped so the long arcs (Limassol to Louisiana or Manila) stay close to the globe
                point.multiplyScalar(1 + Math.sin(Math.PI * t) * Math.min(0.04 + span * 0.16, 0.2));
                points.push(point);
            }
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.ShaderMaterial({
                transparent: true,
                depthWrite: false,
                uniforms: {
                    uTime: { value: 0 },
                    uColor: { value: new THREE.Color(GOLD) },
                    uLength: { value: 1 },
                    uStatic: { value: reducedMotion ? 1 : 0 }
                },
                vertexShader: 'attribute float lineDistance; varying float vDistance; void main() { vDistance = lineDistance; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
                fragmentShader: [
                    'uniform float uTime; uniform vec3 uColor; uniform float uLength; uniform float uStatic; varying float vDistance;',
                    'void main() {',
                    '  float head = fract(uTime * 0.12) * (uLength * 1.5) - uLength * 0.25;',
                    '  float pulse = smoothstep(head - uLength * 0.22, head, vDistance) * (1.0 - step(head, vDistance));',
                    '  float alpha = mix(0.45 + 0.55 * pulse, 0.8, uStatic);',
                    '  gl_FragColor = vec4(uColor, alpha);',
                    '}'
                ].join('\n')
            });
            const line = new THREE.Line(geometry, material);
            line.computeLineDistances();
            const distances = geometry.getAttribute('lineDistance');
            material.uniforms.uLength.value = distances.getX(distances.count - 1);
            arcMaterials.push(material);
            globe.add(line);
        });
    }

    // Rotation state: start centred on the average of the offices
    const average = offices.reduce((sum, office) => sum.add(toVector(office.lat, office.lng)), new THREE.Vector3()).normalize();
    const averageLat = Math.asin(average.y) / DEG;
    const averageLng = (((Math.atan2(average.z, -average.x) / DEG) + 360) % 360) - 180;
    const viewFor = (lat, lng) => ({ x: lat * DEG * 0.8, y: -(lng + 90) * DEG });
    let rotation = viewFor(averageLat, averageLng);
    let target = { x: rotation.x, y: rotation.y };
    let activeIndex = 0;
    let dragging = false;
    let pointerStart = null;
    let lastInteraction = 0;

    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
        dragging = true;
        pointerStart = { x: event.clientX, y: event.clientY, rx: target.x, ry: target.y };
        lastInteraction = performance.now();
        container.classList.add('is-dragging');
        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
        if (!dragging || !pointerStart) {
            return;
        }
        const size = canvas.clientWidth || 1;
        target.y = pointerStart.ry + ((event.clientX - pointerStart.x) / size) * Math.PI;
        target.x = Math.max(-1.1, Math.min(1.1, pointerStart.rx + ((event.clientY - pointerStart.y) / size) * Math.PI));
        lastInteraction = performance.now();
        wake();
    });
    const endDrag = () => {
        dragging = false;
        pointerStart = null;
        container.classList.remove('is-dragging');
        lastInteraction = performance.now();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    // Size to the container
    const resize = () => {
        const size = Math.max(1, Math.round(container.clientWidth));
        renderer.setSize(size, size, false);
        camera.aspect = 1;
        camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    // Render loop runs only while visible
    const projected = new THREE.Vector3();
    const cameraDirection = new THREE.Vector3();
    let visible = true;
    let frame = 0;
    let lastTime = performance.now();

    const update = (now) => {
        const delta = Math.min((now - lastTime) / 1000, 0.05);
        lastTime = now;
        const idle = !dragging && now - lastInteraction > 4000;
        if (idle && !reducedMotion) {
            target.y += delta * 0.06;
        }
        const ease = reducedMotion ? 1 : 1 - Math.pow(0.0025, delta);
        rotation.x += (target.x - rotation.x) * ease;
        rotation.y += (target.y - rotation.y) * ease;
        globe.rotation.set(rotation.x, rotation.y, 0);
        globe.updateMatrixWorld();

        arcMaterials.forEach((material) => { material.uniforms.uTime.value = now / 1000; });

        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        camera.getWorldDirection(cameraDirection);
        markers.forEach((marker, index) => {
            const isActive = index === activeIndex;
            marker.dot.material.color.setHex(isActive ? GOLD : FOAM);
            marker.ring.material.opacity = isActive ? 0.9 : 0;
            const pulse = isActive && !reducedMotion ? 1 + Math.sin(now / 420) * 0.12 : 1;
            marker.ring.scale.setScalar(pulse);

            projected.copy(marker.anchor).applyMatrix4(globe.matrixWorld);
            const facing = projected.clone().normalize().dot(cameraDirection.clone().negate());
            projected.project(camera);
            const x = (projected.x * 0.5 + 0.5) * width;
            const y = (-projected.y * 0.5 + 0.5) * height;
            marker.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -150%)`;
            marker.label.style.opacity = isActive && facing > 0.18 ? '1' : '0';
            marker.label.classList.toggle('is-active', isActive);
        });
        renderer.render(scene, camera);
    };

    const loop = (now) => {
        frame = 0;
        if (!visible || document.hidden) {
            return;
        }
        update(now);
        if (reducedMotion && !dragging) {
            // Nothing moves on its own; wait for the next interaction
            return;
        }
        frame = requestAnimationFrame(loop);
    };

    const wake = () => {
        if (!frame && visible && !document.hidden) {
            lastTime = performance.now();
            frame = requestAnimationFrame(loop);
        }
    };

    const visibilityObserver = new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        wake();
    });
    visibilityObserver.observe(container);
    document.addEventListener('visibilitychange', wake);

    update(performance.now());
    container.classList.add('is-ready');
    wake();

    const shortestTurn = (from, to) => {
        let difference = (to - from) % (Math.PI * 2);
        if (difference > Math.PI) {
            difference -= Math.PI * 2;
        } else if (difference < -Math.PI) {
            difference += Math.PI * 2;
        }
        return from + difference;
    };

    return {
        focus(index, instant) {
            const office = offices[index];
            if (!office) {
                return;
            }
            activeIndex = index;
            const view = viewFor(office.lat, office.lng);
            target = { x: view.x, y: shortestTurn(rotation.y, view.y) };
            if (instant) {
                rotation = { x: target.x, y: target.y };
            }
            lastInteraction = performance.now();
            wake();
        },
        destroy() {
            cancelAnimationFrame(frame);
            visibilityObserver.disconnect();
            resizeObserver.disconnect();
            document.removeEventListener('visibilitychange', wake);
            renderer.dispose();
            container.innerHTML = '';
        }
    };
}
