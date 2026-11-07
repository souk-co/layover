FROM python:3.13-slim
WORKDIR /app
COPY minion/cvm/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY minion/units.py minion/keychain.py ./minion/
COPY minion/cvm/service.py ./minion/cvm/service.py
USER 65534:65534
EXPOSE 8080
CMD ["python", "minion/cvm/service.py"]
