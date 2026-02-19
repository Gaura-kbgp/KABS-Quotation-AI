
const cleanCode = "VDB24AH-3";
const match = cleanCode.match(/^([A-Z0-9]+)(\d{2})([A-Z]+)(-\d+)$/);
console.log(match ? "MATCH" : "NO MATCH");
if (match) {
    console.log("1:", match[1]);
    console.log("2:", match[2]);
    console.log("3:", match[3]);
    console.log("4:", match[4]);
    console.log("Generated:", `${match[1]}${match[2]}${match[4]}`);
}
