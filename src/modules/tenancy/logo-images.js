import sharp from 'sharp';
export const maxLogoBytes=2*1024*1024;
const invalid=status=>Object.assign(new Error('Invalid logo image'),{status});
/** Only raster buffers reach the decoder. Client names/paths are not accepted. */
export async function normaliseLogo(input,contentType) {
  if(!Buffer.isBuffer(input)||!input.length)throw invalid(400);
  if(input.length>maxLogoBytes)throw invalid(413);
  const format=input.length>=8&&input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':
    input.length>=3&&input[0]===255&&input[1]===216&&input[2]===255?'jpeg':
    input.length>=12&&input.toString('ascii',0,4)==='RIFF'&&input.toString('ascii',8,12)==='WEBP'?'webp':null;
  if(!format||contentType!==({png:'image/png',jpeg:'image/jpeg',webp:'image/webp'})[format])throw invalid(415);
  // libvips may treat APNG as a single PNG page. Reject its animation-control
  // chunk explicitly rather than silently accepting an animated source.
  if(format==='png')for(let offset=8;offset+12<=input.length;) {
    const length=input.readUInt32BE(offset);
    if(length>input.length-offset-12)break;
    const chunk=input.toString('ascii',offset+4,offset+8);
    if(chunk==='acTL')throw invalid(400);
    if(chunk==='IEND')break;
    offset+=12+length;
  }
  try {
    const image=sharp(input,{limitInputPixels:4194304,failOn:'warning'});
    const metadata=await image.metadata();
    if(metadata.format!==format||!metadata.width||!metadata.height||(metadata.pages??1)!==1)throw invalid(400);
    const data=await image.rotate().resize({width:512,height:512,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer();
    if(data.length>512*1024)throw invalid(413);
    return data;
  }catch(error){if(error.status)throw error;throw invalid(400);}
}
