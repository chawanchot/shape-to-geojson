import * as shapefile from "shapefile";
import { readFile, writeFile, mkdir } from "fs/promises";
import { createExtractorFromData } from "node-unrar-js";
import path from "path";
import proj4 from "proj4";
import simplify from "@turf/simplify";

const SIMPLIFY_TOLERANCE = 0.001;
const ENABLE_SIMPLIFY = true;

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

    return prjText;
}

// ฟังก์ชันแปลงพิกัดของ geometry เป็น WGS84
function transformGeometry(geometry, sourceCRS) {
    if (!sourceCRS || sourceCRS === WGS84 || sourceCRS === "EPSG:4326") {
        return geometry; // ไม่ต้องแปลง
    }

    const transform = proj4(sourceCRS, WGS84);

    function transformCoords(coords, depth = 0) {
        if (depth === 0) {
            const [x, y] = transform.forward(coords);
            return [x, y];
        } else {
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

        console.log(`downloading: ${rarPath}`);
        const response = await fetch(rarPath);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        rarData = Buffer.from(arrayBuffer);

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
                    console.log(` - แปลงเป็น: WGS84 (EPSG:4326)`);
                }

                const source = await shapefile.open(
                    fileSet[".shp"],
                    fileSet[".dbf"],
                    { encoding: "tis-620" }, // Thai encoding
                );

                const features = [];
                let result;

                while (!(result = await source.read()).done) {
                    const feature = result.value;

                    // แปลงพิกัดเป็น WGS84
                    if (feature.geometry) {
                        feature.geometry = transformGeometry(
                            feature.geometry,
                            sourceCRS || UTM_ZONE_47N,
                        );

                        // Simplify geometry เพื่อลดขนาดไฟล์
                        if (
                            ENABLE_SIMPLIFY &&
                            (feature.geometry.type === "Polygon" ||
                                feature.geometry.type === "MultiPolygon" ||
                                feature.geometry.type === "LineString" ||
                                feature.geometry.type === "MultiLineString")
                        ) {
                            const simplified = simplify(feature, {
                                tolerance: SIMPLIFY_TOLERANCE,
                                highQuality: true,
                            });
                            feature.geometry = simplified.geometry;
                        }
                    }

                    features.push(feature);
                }

                const geojson = {
                    type: "FeatureCollection",
                    features: features,
                };

                results.push({ name, geojson });
                console.log(` - แปลงสำเร็จ: ${features.length} features`);
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
    } catch (error) {
        console.error("เกิดข้อผิดพลาด:", error);
        throw error; // ส่งต่อ error เพื่อให้ batch process จัดการได้
    }
}

const soilgroup = {
    // "N/sg_kpt": "kamphaengphet",
    // "N/sg_cmi": "chiangmai",
    // "N/sg_cri": "chiangrai",
    // "N/sg_tak": "tak",
    // "N/sg_nan": "nan",
    // "N/sg_nsn": "nakhonsawan",
    // "N/sg_pyo": "phayao",
    // "N/sg_pct": "phichit",
    // "N/sg_plk": "phitsanulok",
    // "N/sg_pbn": "phetchabun",
    // "N/sg_msn": "maehongson",
    // "N/sg_pre": "phrae",
    // "N/sg_lpg": "lampang",
    // "N/sg_lpn": "lamphun",
    // "N/sg_sti": "sukhothai",
    // "N/sg_utt": "uttaradit",
    // "N/sg_uti": "uthaithani",
    // "NE/sg_ksn": "kalasin",
    // "NE/sg_mkm": "mahasarakham",
    // "NE/sg_srn": "surin",
    // "NE/sg_kkn": "khonkaen",
    // "NE/sg_mdh": "mukdahan",
    // "NE/sg_nki": "nongkhai",
    // "NE/sg_cpm": "chaiyaphum",
    // "NE/sg_yst": "yasothon",
    // "NE/sg_nbl": "nongbualamphu",
    // "NE/sg_npn": "nakhonphanom",
    // "NE/sg_ret": "roiet",
    // "NE/sg_anc": "amnatcharoen",
    // "NE/sg_nma": "nakhonratchasima",
    // "NE/sg_lei": "loei",
    // "NE/sg_udn": "udonthani",
    // "NE/sg_bkn": "buengkan",
    // "NE/sg_ssk": "sisaket",
    // "NE/sg_ubn": "ubonratchathani",
    // "NE/sg_brm": "buriram",
    // "NE/sg_snk": "sakonnakhon",
    // "C/sg_kri": "kanchanaburi",
    // "C/sg_aya": "phranakhonsiayutthaya",
    // "C/sg_sri": "saraburi",
    // "C/sg_bkk": "bangkok",
    // "C/sg_rbr": "ratchaburi",
    // "C/sg_sbr": "singburi",
    // "C/sg_cnt": "chainat",
    // "C/sg_lri": "lopburi",
    // "C/sg_spb": "suphanburi",
    // "C/sg_nyk": "nakhonnayok",
    // "C/sg_smp": "samutprakan",
    // "C/sg_atg": "angthong",
    // "C/sg_npt": "nakhonpathom",
    // "C/sg_skm": "samutsongkhram",
    // "C/sg_pkn": "prachuapkhirikhan",
    // "C/sg_ntb": "nonthaburi",
    // "C/sg_skn": "samutsakhon",
    // "C/sg_pbi": "phetchaburi",
    // "C/sg_ptm": "pathumthani",
    // "E/sg_cti": "chanthaburi",
    // "E/sg_trt": "trat",
    // "E/sg_sko": "sakaeo",
    // "E/sg_cco": "chachoengsao",
    // "E/sg_pri": "prachinburi",
    // "E/sg_ryg": "rayong",
    // "E/sg_cbi": "chonburi",
    // "S/sg_cpn": "chumphon",
    // "S/sg_yla": "yala",
    // "S/sg_trg": "trang",
    // "S/sg_nrt": "nakhonsithammarat",
    // "S/sg_rng": "ranong",
    // "S/sg_plg": "phatthalung",
    // "S/sg_nwt": "narathiwat",
    // "S/sg_pkt": "phuket",
    // "S/sg_ptn": "pattani",
    // "S/sg_sni": "suratthani",
    // "S/sg_ska": "songkhla",
    // "S/sg_pna": "phangnga",
    // "S/sg_kbi": "krabi",
    "S/sg_stn": "satun",
};

const sources = Object.entries(soilgroup).map(([code, provinceSlug]) => {
    return {
        url: `https://tswc.ldd.go.th/DownloadGIS/web_Soilgroup/DataSoilgroup/${code}.rar`,

        // ใช้ value เป็นชื่อไฟล์ output
        outputPath: `output/${provinceSlug}.json`,
    };
});

await mkdir("./output", { recursive: true });

console.log(`start convert ${sources.length} files\n`);

const results = [];

for (let i = 0; i < sources.length; i++) {
    const { url, outputPath } = sources[i];
    console.log(`[${i + 1}/${sources.length}]`);

    try {
        await extractRarAndConvert(url, outputPath);
        results.push({ url, outputPath, status: "success" });
        console.log(`success\n`);
    } catch (error) {
        results.push({
            url,
            outputPath,
            status: "failed",
            error: error.message,
        });
        console.error(`failed: ${error.message}\n`);
    }
}

console.log("\n=== summary ===");
console.log(`success: ${results.filter((r) => r.status === "success").length}`);
console.log(`failed: ${results.filter((r) => r.status === "failed").length}`);
