import * as shapefile from "shapefile";
import { readFile, writeFile, mkdir } from "fs/promises";
import { createExtractorFromData } from "node-unrar-js";
import path from "path";
import proj4 from "proj4";
import simplify from "@turf/simplify";

// การตั้งค่า simplification
const SIMPLIFY_TOLERANCE = 0.001; // ค่ายิ่งมาก ลดรายละเอียดยิ่งมาก (0.0001 = ละเอียดมาก, 0.001 = ปานกลาง, 0.01 = น้อย)
const ENABLE_SIMPLIFY = true; // เปิด/ปิด simplification

// กำหนดระบบพิกัดสำหรับประเทศไทย
const UTM_ZONE_47N = "+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs";
const UTM_ZONE_48N = "+proj=utm +zone=48 +datum=WGS84 +units=m +no_defs";
const WGS84 = "EPSG:4326";

// ฟังก์ชันอ่าน projection จากไฟล์ .prj
function parsePrjFile(prjBuffer) {
    if (!prjBuffer) return null;
    const prjText = prjBuffer.toString("utf-8");

    // ตรวจสอบว่าเป็น UTM Zone ไหน
    if (prjText.includes("UTM_Zone_47") || prjText.includes("UTM Zone 47")) {
        return UTM_ZONE_47N;
    } else if (
        prjText.includes("UTM_Zone_48") ||
        prjText.includes("UTM Zone 48")
    ) {
        return UTM_ZONE_48N;
    } else if (prjText.includes("GCS_WGS_1984") || prjText.includes("WGS 84")) {
        return WGS84;
    }

    // ถ้าไม่รู้จัก ลองใช้ .prj text โดยตรง
    return prjText;
}

// ฟังก์ชันแปลงพิกัดของ geometry
function transformGeometry(geometry, sourceCRS) {
    if (!sourceCRS || sourceCRS === WGS84 || sourceCRS === "EPSG:4326") {
        return geometry; // ไม่ต้องแปลง
    }

    const transform = proj4(sourceCRS, WGS84);

    function transformCoords(coords, depth = 0) {
        if (depth === 0) {
            // Single coordinate [x, y]
            const [x, y] = transform.forward(coords);
            return [x, y];
        } else {
            // Nested array
            return coords.map((c) => transformCoords(c, depth - 1));
        }
    }

    const transformed = { ...geometry };

    switch (geometry.type) {
        case "Point":
            transformed.coordinates = transformCoords(geometry.coordinates, 0);
            break;
        case "LineString":
        case "MultiPoint":
            transformed.coordinates = transformCoords(geometry.coordinates, 1);
            break;
        case "Polygon":
        case "MultiLineString":
            transformed.coordinates = transformCoords(geometry.coordinates, 2);
            break;
        case "MultiPolygon":
            transformed.coordinates = transformCoords(geometry.coordinates, 3);
            break;
    }

    return transformed;
}

async function extractRarAndConvert(rarPath, outputJsonPath) {
    try {
        let rarData;

        // ตรวจสอบว่าเป็น URL หรือ local file path
        if (rarPath.startsWith("http://") || rarPath.startsWith("https://")) {
            console.log(`downloading: ${rarPath}`);
            const response = await fetch(rarPath);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            rarData = Buffer.from(arrayBuffer);
        } else {
            // อ่านไฟล์ RAR จาก local
            rarData = await readFile(rarPath);
        }

        // แตกไฟล์ RAR
        const extractor = await createExtractorFromData({ data: rarData });
        const extracted = extractor.extract();

        // สร้าง temp folder
        const tempDir = "./temp_extracted";
        await mkdir(tempDir, { recursive: true });

        // เก็บไฟล์ที่แตกออกมา
        const files = [...extracted.files];

        // หาไฟล์ shapefile (.shp, .shx, .dbf, .prj)
        const shapeFiles = {};

        for (const file of files) {
            if (file.extraction) {
                const fileName = path.basename(file.fileHeader.name);
                const ext = path.extname(fileName).toLowerCase();

                if ([".shp", ".shx", ".dbf", ".prj", ".cpg"].includes(ext)) {
                    const baseName = path.basename(fileName, ext);
                    if (!shapeFiles[baseName]) {
                        shapeFiles[baseName] = {};
                    }
                    shapeFiles[baseName][ext] = Buffer.from(file.extraction);
                }
            }
        }

        // แปลงแต่ละ shapefile เป็น GeoJSON
        const results = [];

        for (const [name, fileSet] of Object.entries(shapeFiles)) {
            if (fileSet[".shp"] && fileSet[".dbf"]) {
                console.log(`converting: ${name}`);

                // อ่าน projection จากไฟล์ .prj
                const sourceCRS = parsePrjFile(fileSet[".prj"]);
                if (sourceCRS) {
                    console.log(`  - แปลงเป็น: WGS84 (EPSG:4326)`);
                } else {
                    console.log(
                        `  - ไม่พบไฟล์ .prj, สันนิษฐานว่าเป็น UTM Zone 47N`,
                    );
                }

                // ใช้ shapefile library ที่รองรับ encoding
                const source = await shapefile.open(
                    fileSet[".shp"],
                    fileSet[".dbf"],
                    { encoding: "tis-620" }, // Thai encoding
                );

                const features = [];
                let result;
                let originalSize = 0;
                let simplifiedSize = 0;
                
                while (!(result = await source.read()).done) {
                    const feature = result.value;

                    // แปลงพิกัดเป็น WGS84
                    if (feature.geometry) {
                        feature.geometry = transformGeometry(
                            feature.geometry,
                            sourceCRS || UTM_ZONE_47N,
                        );
                        
                        // นับจำนวนพิกัดก่อน simplify
                        originalSize += JSON.stringify(feature.geometry).length;
                        
                        // Simplify geometry เพื่อลดขนาดไฟล์
                        if (ENABLE_SIMPLIFY && (feature.geometry.type === 'Polygon' || 
                            feature.geometry.type === 'MultiPolygon' || 
                            feature.geometry.type === 'LineString' || 
                            feature.geometry.type === 'MultiLineString')) {
                            
                            const simplified = simplify(feature, {
                                tolerance: SIMPLIFY_TOLERANCE,
                                highQuality: true
                            });
                            feature.geometry = simplified.geometry;
                        }
                        
                        // นับจำนวนพิกัดหลัง simplify
                        simplifiedSize += JSON.stringify(feature.geometry).length;
                    }

                    features.push(feature);
                }

                const geojson = {
                    type: "FeatureCollection",
                    features: features,
                };

                results.push({ name, geojson });
                
                // แสดงสถิติการลดขนาด
                const reductionPercent = ((1 - simplifiedSize / originalSize) * 100).toFixed(2);
                console.log(`  - แปลงสำเร็จ: ${features.length} features`);
                if (ENABLE_SIMPLIFY) {
                    console.log(`  - ลดขนาด geometry: ${reductionPercent}% (จาก ${(originalSize/1024).toFixed(2)} KB เป็น ${(simplifiedSize/1024).toFixed(2)} KB)`);
                }
            }
        }

        // บันทึกผลลัพธ์
        if (results.length === 1) {
            await writeFile(
                outputJsonPath,
                JSON.stringify(results[0].geojson, null, 2),
            );
        } else {
            // ถ้ามีหลายไฟล์ รวมเป็น object
            const combined = {};
            for (const { name, geojson } of results) {
                combined[name] = geojson;
            }
            await writeFile(outputJsonPath, JSON.stringify(combined, null, 2));
        }

        console.log(`success! file path: ${outputJsonPath}`);
    } catch (error) {
        console.error("เกิดข้อผิดพลาด:", error);
        throw error; // ส่งต่อ error เพื่อให้ batch process จัดการได้
    }
}

// ฟังก์ชันสำหรับ batch processing
async function batchConvert(sources) {
    console.log(`start convert ${sources.length} files\n`);

    const results = [];
    for (let i = 0; i < sources.length; i++) {
        const { url, outputPath } = sources[i];
        console.log(`[${i + 1}/${sources.length}]`);

        try {
            await extractRarAndConvert(url, outputPath);
            results.push({ url, outputPath, status: "success" });
            console.log(`✓ success\n`);
        } catch (error) {
            results.push({
                url,
                outputPath,
                status: "failed",
                error: error.message,
            });
            console.error(`✗ failed: ${error.message}\n`);
        }
    }

    // สรุปผลลัพธ์
    console.log("\n=== summary ===");
    console.log(
        `success: ${results.filter((r) => r.status === "success").length}`,
    );
    console.log(
        `failed: ${results.filter((r) => r.status === "failed").length}`,
    );

    return results;
}

// ตัวอย่างการใช้งาน - แบบ local file
// extractRarAndConvert("./sg_pkt.rar", "soilgroup_pkt.json");

// แบบ batch processing หลายไฟล์
const sources = [
    {
        url: "https://tswc.ldd.go.th/DownloadGIS/web_Soilgroup/DataSoilgroup/E/sg_pri.rar",
        outputPath: "output/soilgroup_pri.json",
    },
    {
        url: "https://tswc.ldd.go.th/DownloadGIS/web_Soilgroup/DataSoilgroup/C/sg_sbr.rar",
        outputPath: "output/soilgroup_sbr.json",
    },
    {
        url: "https://tswc.ldd.go.th/DownloadGIS/web_Soilgroup/DataSoilgroup/S/sg_plg.rar",
        outputPath: "output/soilgroup_plg.json",
    },
    {
        url: "https://tswc.ldd.go.th/DownloadGIS/web_Soilgroup/DataSoilgroup/N/sg_nan.rar",
        outputPath: "output/soilgroup_nan.json",
    },
];

await mkdir("./output", { recursive: true });
batchConvert(sources);
