document.addEventListener("DOMContentLoaded", async function () {
    document.getElementById("appInfo").textContent = `${appName} ${appVersion}`;

    // Feeback Button
    document.getElementById('feedbackBtn').onclick = function(event) {
        event.preventDefault(); // prevent the jump
        document.getElementById('feedbackModal').style.display = "block";
    };

    document.getElementById('closeModal').onclick = function(event) {
        event.preventDefault(); // prevent the jump
        document.getElementById('feedbackModal').style.display = "none";
    };

    document.getElementById('feedbackForm').onsubmit = async function(event) {
        event.preventDefault();
    
        const type = document.getElementById('type').value;
        const description = document.getElementById('description').value;
        const userEmail = document.getElementById('userFeedbackEmail').value;
        const screenshotInput = document.getElementById('screenshot');
    
        let screenshotBase64 = null;
    
        if (screenshotInput.files.length > 0) {
            const file = screenshotInput.files[0];
            screenshotBase64 = await toBase64(file);
        }
    
        const data = {
            tool: appName,
            type: type,
            description: description,
            userEmail: userEmail,
            screenshotBase64: screenshotBase64
        };
    
        try {
            const response = await fetch('https://prod-07.uksouth.logic.azure.com:443/workflows/9c87a5536bdb4693a934559d0ce9d483/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=B29hnHMorKKwLVyZquwnJLNth1wSAnL2VAhPd779XzY', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });
    
            if (response.ok) {
                alert('Report submitted!');
                document.getElementById('feedbackModal').style.display = "none";
                document.getElementById('feedbackForm').reset();
            } else {
                alert('Failed to submit.');
            }
        } catch (error) {
            console.error('Error submitting:', error);
            alert('An error occurred.');
        }
    };
    
    // Helper function to convert file to base64
    function toBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve(reader.result);
            reader.onerror = error => reject(error);
        });
    }
    
})