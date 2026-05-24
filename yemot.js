// פונקציה לבדיקה האם המספר קיים ברשימה
export async function checkPhoneStatus(phone, token) {
    const url = `https://www.call2all.co.il/ym/api/TzintukimListManagement?token=${token}&action=getlistEnteres&TzintukimList=members`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.responseStatus !== 'OK') return { exists: false };

    // חיפוש המספר במערך הכללי (enteres)
    const userInList = data.enteres.find(u => u.phone === phone);
    
    if (userInList) {
        return { exists: true, active: userInList.active };
    }
    
    return { exists: false };
}

// פונקציה לשליפת השם מקובץ ה-INI
export async function getNameFromIni(phone, token) {
    const url = `https://www.call2all.co.il/ym/api/GetTextFile?token=${token}&what=ivr2:/EnterID/EnterIDValName.ini`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.responseStatus !== 'OK' || !data.contents) return null;

    // פיצול התוכן לשורות וחיפוש המספר
    const lines = data.contents.split('\n');
    for (const line of lines) {
        const [linePhone, lineName] = line.split('=');
        if (linePhone === phone && lineName) {
            return lineName.trim();
        }
    }
    
    return null;
}
